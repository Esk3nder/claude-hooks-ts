import * as path from "node:path"
import type { WorkerRun } from "../schema/worker-run.ts"
import { evaluateSecretPath } from "../policies/secret-paths.ts"
import { DEFAULT_POLICY } from "./policy-config.ts"

export const DERIVED_WORKER_CONTEXT_MARKER = "<derived-worker-context>"

const DERIVED_WORKER_CONTEXT_END_MARKER = "</derived-worker-context>"
const DEFAULT_MAX_CHARS = 2_000
const DEFAULT_MAX_ITEMS_PER_SECTION = 6
const MIN_REPEAT_COUNT = 2
const MAX_RENDERED_DATA_VALUE_CHARS = 240

export interface WorkerContextOptions {
  readonly maxChars?: number
  readonly maxItemsPerSection?: number
  readonly secretValuePatterns?: ReadonlyArray<RegExp>
}

interface CountedValue {
  readonly value: string
  readonly count: number
}

const workerResult = (run: WorkerRun) => run.result ?? run.output

const isVerifiedStructuredRun = (run: WorkerRun): boolean => {
  if (run.status !== "completed" || run.result_unstructured === true) return false
  const result = workerResult(run)
  if (result === undefined || result.verification.length === 0) return false
  return result.verification.every((check) => check.status === "passed")
}

const isStructuredFailedRun = (run: WorkerRun): boolean =>
  run.result_unstructured !== true && (run.status === "failed" || run.status === "blocked")

const cloneSecretPattern = (pattern: RegExp): RegExp =>
  new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  )

const secretValuePatternsForOptions = (
  options: WorkerContextOptions,
): ReadonlyArray<RegExp> =>
  (options.secretValuePatterns ?? DEFAULT_POLICY.secretValuePatterns).map(cloneSecretPattern)

const redactSecrets = (value: string, secretValuePatterns: ReadonlyArray<RegExp>): string => {
  let out = value
  for (const pattern of secretValuePatterns) {
    pattern.lastIndex = 0
    out = out.replace(pattern, "[REDACTED]")
  }
  return out
}

const normalizeValue = (
  value: string,
  secretValuePatterns: ReadonlyArray<RegExp>,
): string =>
  redactSecrets(value, secretValuePatterns).replace(/\s+/g, " ").trim()

const safeRelativePath = (value: string): string => {
  const candidate = path.posix.normalize(value.replace(/\\/g, "/")).replace(/^\.\/+/, "")
  if (
    candidate.length === 0 ||
    candidate === "." ||
    candidate === ".." ||
    candidate.startsWith("../") ||
    path.posix.isAbsolute(candidate) ||
    evaluateSecretPath(candidate).kind === "deny"
  ) {
    return ""
  }
  return candidate
}

const relativePosixPath = (
  workspacePath: string | undefined,
  absolutePath: string,
  secretValuePatterns: ReadonlyArray<RegExp>,
): string => {
  if (workspacePath === undefined) return ""
  const workspace = normalizeValue(workspacePath, secretValuePatterns).replace(/\\/g, "/")
  if (!path.posix.isAbsolute(workspace)) return ""
  return safeRelativePath(path.posix.relative(path.posix.normalize(workspace), path.posix.normalize(absolutePath)))
}

const relativeWin32Path = (
  workspacePath: string | undefined,
  absolutePath: string,
  secretValuePatterns: ReadonlyArray<RegExp>,
): string => {
  if (workspacePath === undefined) return ""
  const workspace = normalizeValue(workspacePath, secretValuePatterns)
  if (!path.win32.isAbsolute(workspace)) return ""
  return safeRelativePath(path.win32.relative(path.win32.normalize(workspace), path.win32.normalize(absolutePath)))
}

const normalizePath = (
  value: string,
  workspacePath: string | undefined,
  secretValuePatterns: ReadonlyArray<RegExp>,
): string => {
  const normalized = normalizeValue(value, secretValuePatterns)
  if (normalized.length === 0) return ""
  if (path.win32.isAbsolute(normalized)) {
    return relativeWin32Path(workspacePath, normalized, secretValuePatterns)
  }
  const posixPath = normalized.replace(/\\/g, "/")
  if (path.posix.isAbsolute(posixPath)) {
    return relativePosixPath(workspacePath, posixPath, secretValuePatterns)
  }
  return safeRelativePath(posixPath)
}

const addRunValues = (
  counts: Map<string, number>,
  values: Iterable<string>,
  secretValuePatterns: ReadonlyArray<RegExp>,
): void => {
  const unique = new Set<string>()
  for (const value of values) {
    const normalized = normalizeValue(value, secretValuePatterns)
    if (normalized.length > 0) unique.add(normalized)
  }
  for (const value of unique) counts.set(value, (counts.get(value) ?? 0) + 1)
}

const counted = (
  counts: Map<string, number>,
  maxItems: number,
): ReadonlyArray<CountedValue> =>
  [...counts.entries()]
    .filter(([, count]) => count >= MIN_REPEAT_COUNT)
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .slice(0, maxItems)

const sectionLines = (
  title: string,
  items: ReadonlyArray<CountedValue>,
  render: (item: CountedValue) => string,
): ReadonlyArray<string> =>
  items.length === 0 ? [] : [title, ...items.map(render)]

const renderDataValue = (value: string): string => {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ")
  const boundedValue = cleaned.length <= MAX_RENDERED_DATA_VALUE_CHARS
    ? cleaned
    : `${cleaned.slice(0, MAX_RENDERED_DATA_VALUE_CHARS - 3)}...`
  return JSON.stringify(boundedValue)
}

const bounded = (lines: ReadonlyArray<string>, maxChars: number): string => {
  if (maxChars <= 0) return ""
  const full = lines.join("\n")
  if (full.length <= maxChars) return full

  const footer = ["... truncated", DERIVED_WORKER_CONTEXT_END_MARKER]
  const minimum = [DERIVED_WORKER_CONTEXT_MARKER, ...footer].join("\n")
  if (minimum.length > maxChars) return ""
  const kept: string[] = [DERIVED_WORKER_CONTEXT_MARKER]
  for (const line of lines.slice(1, -1)) {
    const candidate = [...kept, line, ...footer].join("\n")
    if (candidate.length > maxChars) break
    kept.push(line)
  }

  const truncated = [...kept, ...footer].join("\n")
  return truncated.length <= maxChars ? truncated : truncated.slice(0, maxChars)
}

export const buildWorkerContextBlock = (
  runs: ReadonlyArray<WorkerRun>,
  options: WorkerContextOptions = {},
): string => {
  const maxChars = Math.max(0, options.maxChars ?? DEFAULT_MAX_CHARS)
  const maxItems = Math.max(1, options.maxItemsPerSection ?? DEFAULT_MAX_ITEMS_PER_SECTION)
  const secretValuePatterns = secretValuePatternsForOptions(options)
  const fileCounts = new Map<string, number>()
  const checkCounts = new Map<string, number>()
  const commandCounts = new Map<string, number>()
  const blockerCounts = new Map<string, number>()

  for (const run of runs) {
    if (isStructuredFailedRun(run)) {
      addRunValues(
        blockerCounts,
        [run.failure_reason ?? "", run.blocked_reason ?? ""],
        secretValuePatterns,
      )
    }

    if (!isVerifiedStructuredRun(run)) continue
    const result = workerResult(run)
    if (result === undefined) continue

    const files = [
      ...result.files_relevant.map((file) =>
        normalizePath(file.path, run.workspace_path, secretValuePatterns)
      ),
      ...result.changes_made.map((change) =>
        normalizePath(change.path, run.workspace_path, secretValuePatterns)
      ),
      ...(run.patch_changed_files ?? []).map((file) =>
        normalizePath(file, run.workspace_path, secretValuePatterns)
      ),
    ].filter((filePath) => filePath.length > 0)

    addRunValues(fileCounts, files, secretValuePatterns)
    addRunValues(
      checkCounts,
      result.verification
        .filter((check) => check.status === "passed")
        .map((check) => check.check),
      secretValuePatterns,
    )
    addRunValues(
      commandCounts,
      result.commands_run
        .filter((command) => command.exit_code === 0)
        .map((command) => command.command),
      secretValuePatterns,
    )
    addRunValues(blockerCounts, result.blockers, secretValuePatterns)
  }

  const contentLines = [
    ...sectionLines("Repeated relevant files:", counted(fileCounts, maxItems), (item) =>
      `- ${item.value} (${item.count})`,
    ),
    ...sectionLines("Accepted verification:", counted(checkCounts, maxItems), (item) =>
      `- check: ${renderDataValue(item.value)} (${item.count})`,
    ),
    ...sectionLines("Accepted commands:", counted(commandCounts, maxItems), (item) =>
      `- command: ${renderDataValue(item.value)} (${item.count})`,
    ),
    ...sectionLines("Repeated blockers/failures:", counted(blockerCounts, maxItems), (item) =>
      `- ${renderDataValue(item.value)} (${item.count})`,
    ),
  ]
  if (contentLines.length === 0) return ""

  const lines = [
    DERIVED_WORKER_CONTEXT_MARKER,
    ...contentLines,
    DERIVED_WORKER_CONTEXT_END_MARKER,
  ]

  return bounded(lines, maxChars)
}
