/**
 * Verify-map — declarative "when source files changed, run this verification
 * command at Stop" rules read from `<repo>/.claude-hooks/verify-map.yaml`.
 *
 * Unlike `regenerate.yaml` (best-effort doc regen, never blocks), verify-map
 * rules CAN block Stop. The Stop handler selects ONE rule per Stop (highest
 * priority, then most-specific source glob), runs the command, and updates
 * `verification_status` accordingly. Failure/timeout returns a block decision
 * with the command + captured output tail.
 *
 * **Trust boundary.** `verify-map.yaml` is treated as trusted user config —
 * the same boundary as `regenerate.yaml`, `package.json` scripts, and the
 * settings.json hook entries themselves. The Stop handler will exec whatever
 * command appears here, with the privileges of the Claude Code process,
 * inside the shell's cwd. Do NOT commit a `verify-map.yaml` you wouldn't
 * trust to run at completion of every Stop. Reading the file is gated on a
 * cwd-scoped resolution that matches `regenerate.yaml`'s semantics.
 *
 * YAML shape:
 *
 *   rules:
 *     - source: "src/algorithm/isa/*.ts"
 *       command: ["bun", "test", "test/algorithm/isa"]
 *       timeoutMs: 20000
 *       priority: 10
 *
 *     - source: "src/*.ts"
 *       command: bun run typecheck
 *       priority: 100
 *
 * - `source` is a `*`-only glob (no `**`, no character classes, no braces).
 * - `command` is either a shell string (run via `sh -c` — shell-interpreted)
 *   or a `[cmd, ...args]` argv array (preferred — no shell escaping concerns).
 * - `timeoutMs` defaults to {@link DEFAULT_VERIFY_TIMEOUT_MS}; capped at
 *   {@link MAX_VERIFY_TIMEOUT_MS}.
 * - `priority` defaults to {@link DEFAULT_VERIFY_PRIORITY}. LOWER wins.
 *
 * Selection is **one rule per Stop** — for repos that need multiple checks,
 * compose them into one wrapper script (e.g. `verify:changed`).
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { normalizePathPattern } from "./path-utils.ts"
import { runCommandLive, runShellCommandLive } from "../services/command-runner.ts"
import { logWarningSync } from "../services/diagnostics.ts"

const VERIFY_MAP_SUBPATH = [".claude-hooks", "verify-map.yaml"] as const

export const verifyMapPathFor = (root: string = process.cwd()): string =>
  join(root, ...VERIFY_MAP_SUBPATH)

export const DEFAULT_VERIFY_TIMEOUT_MS = 15_000
export const MAX_VERIFY_TIMEOUT_MS = 22_000
export const DEFAULT_VERIFY_PRIORITY = 100

export interface VerifyRule {
  readonly source: string
  readonly command: string | ReadonlyArray<string>
  readonly timeoutMs: number
  readonly priority: number
}

interface ParseSuccess {
  readonly _tag: "ok"
  readonly rules: ReadonlyArray<VerifyRule>
}
interface ParseFailure {
  readonly _tag: "fail"
  readonly message: string
}

const clampTimeout = (n: number): number => {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_VERIFY_TIMEOUT_MS
  return Math.min(Math.floor(n), MAX_VERIFY_TIMEOUT_MS)
}

const stripTrailingComment = (line: string): string => {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === "#" && !inSingle && !inDouble) {
      const prev = i > 0 ? line[i - 1] : ""
      if (prev === " " || prev === "\t") return line.slice(0, i - 1)
    }
  }
  return line
}

interface Draft {
  source?: string
  command?: string | string[]
  timeoutMs?: number
  priority?: number
}

const parseScalarNumber = (val: string): number | null => {
  const trimmed = val.trim()
  if (trimmed.length === 0) return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

const parseCommandValue = (val: string): string | string[] | null => {
  const trimmed = val.trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const arr = JSON.parse(trimmed) as unknown
      if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) {
        return arr as string[]
      }
    } catch {
      // fall through — treat as string
    }
  }
  return trimmed.replace(/^["']|["']$/g, "")
}

const assignKey = (draft: Draft, key: string, val: string): void => {
  if (key === "source") {
    draft.source = val.replace(/^["']|["']$/g, "")
    return
  }
  if (key === "command") {
    const c = parseCommandValue(val)
    if (c !== null) draft.command = c
    return
  }
  if (key === "timeoutMs" || key === "priority") {
    const n = parseScalarNumber(val)
    if (n !== null) draft[key] = n
  }
}

export const parseVerifyMapYaml = (raw: string): ParseSuccess | ParseFailure => {
  const lines = raw.split("\n")
  let inRules = false
  const rules: VerifyRule[] = []
  let current: Draft = {}

  const flush = (): void => {
    if (typeof current.source === "string" && current.command !== undefined) {
      rules.push({
        source: current.source,
        command: current.command,
        timeoutMs: clampTimeout(current.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS),
        priority: current.priority ?? DEFAULT_VERIFY_PRIORITY,
      })
    }
    current = {}
  }

  for (const rawLine of lines) {
    const line = stripTrailingComment(rawLine).trimEnd()
    if (line.length === 0) continue
    if (/^rules\s*:\s*$/.test(line)) {
      inRules = true
      continue
    }
    if (!inRules) continue
    const itemHeadMatch = line.match(/^\s*-\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
    if (itemHeadMatch && itemHeadMatch[1] !== undefined && itemHeadMatch[2] !== undefined) {
      flush()
      assignKey(current, itemHeadMatch[1], itemHeadMatch[2])
      continue
    }
    const subMatch = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
    if (subMatch && subMatch[1] !== undefined && subMatch[2] !== undefined) {
      assignKey(current, subMatch[1], subMatch[2])
    }
  }
  flush()

  return { _tag: "ok", rules }
}

/**
 * Compile a `*`-only glob to a RegExp anchored start-to-end.
 *   `*`        → `.*`
 *   `**` `?` … → unsupported; treated literally after escape.
 */
const globToRegex = (glob: string): RegExp => {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`)
}

const specificityOf = (source: string): number =>
  normalizePathPattern(source).replace(/\*/g, "").length

/** Filter to rules whose `source` matches at least one changed file. */
export const matchVerifyRules = (
  changedFiles: ReadonlyArray<string>,
  rules: ReadonlyArray<VerifyRule>,
): ReadonlyArray<VerifyRule> => {
  const out: VerifyRule[] = []
  for (const r of rules) {
    const re = globToRegex(normalizePathPattern(r.source))
    if (changedFiles.some((f) => re.test(f))) out.push(r)
  }
  return out
}

/**
 * Pick the single verifier command for this Stop. Selection order:
 *   1. lower priority first
 *   2. higher source specificity next (more literal chars)
 *   3. original rule order tie-break (stable)
 * Returns null when no rule matches.
 */
export const selectVerifyCommand = (
  changedFiles: ReadonlyArray<string>,
  rules: ReadonlyArray<VerifyRule>,
): VerifyRule | null => {
  const matched = matchVerifyRules(changedFiles, rules)
  if (matched.length === 0) return null
  const indexed = matched.map((rule, idx) => ({ rule, idx }))
  indexed.sort((a, b) => {
    if (a.rule.priority !== b.rule.priority) return a.rule.priority - b.rule.priority
    const sa = specificityOf(a.rule.source)
    const sb = specificityOf(b.rule.source)
    if (sa !== sb) return sb - sa
    return a.idx - b.idx
  })
  return indexed[0]?.rule ?? null
}

/** Load + parse the verify-map. Returns [] on absence; warns on parse fail. */
export const loadVerifyRules = (
  root: string = process.cwd(),
): ReadonlyArray<VerifyRule> => {
  const p = verifyMapPathFor(root)
  if (!existsSync(p)) return []
  let raw: string
  try {
    raw = readFileSync(p, "utf-8")
  } catch {
    return []
  }
  const parsed = parseVerifyMapYaml(raw)
  if (parsed._tag === "fail") {
    logWarningSync(`[verify-map] parse failed: ${parsed.message}`)
    return []
  }
  return parsed.rules
}

export interface VerifyRunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly durationMs: number
  readonly commandPreview: string
}

const previewOf = (command: string | ReadonlyArray<string>): string =>
  Array.isArray(command) ? command.join(" ") : (command as string)

/**
 * Run a single verify-map rule. Honors `rule.timeoutMs`. Captures stdout +
 * stderr; on non-zero exit OR timeout, returns the captured buffers — the
 * caller is responsible for trimming for the Stop block reason.
 */
export const runVerifyCommand = async (
  rule: VerifyRule,
  cwd: string,
): Promise<VerifyRunResult> => {
  const startedAt = Date.now()
  const commandPreview = previewOf(rule.command)
  const exec = Array.isArray(rule.command)
    ? { cmd: rule.command[0] ?? "", argv: rule.command.slice(1) as string[] }
    : { cmd: "sh", argv: ["-c", rule.command as string] }

  if (exec.cmd.length === 0) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: "verify-map: empty command",
      timedOut: false,
      durationMs: 0,
      commandPreview,
    }
  }

  try {
    const result = Array.isArray(rule.command)
      ? await runCommandLive(exec.cmd, exec.argv, { cwd, timeoutMs: rule.timeoutMs })
      : await runShellCommandLive(rule.command as string, { cwd, timeoutMs: rule.timeoutMs })
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      commandPreview,
    }
  } catch (err) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: String(err),
      timedOut: false,
      durationMs: Date.now() - startedAt,
      commandPreview,
    }
  }
}

/** Trim a buffer to the last `maxChars` characters for human-readable tails. */
export const tailOf = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text
  return `…${text.slice(text.length - maxChars)}`
}
