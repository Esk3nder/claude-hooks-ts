/**
 * TDD-first PreToolUse gate (US-1).
 *
 * Optional gate (default OFF via `tddGateEnabled`) that blocks Write / Edit /
 * MultiEdit / NotebookEdit on non-test source files unless a companion test
 * file exists OR was touched in the current session. Converts TDD from a
 * documented practice into one enforced by the hook layer.
 *
 * Shape mirrors the engagement-gate (deep entry + pure shallow form).
 *
 * Release conditions (the gate becomes inert for a given write):
 *   - tddGateEnabled === false (global opt-out, default)
 *   - tool is not a write tool, or no `file_path` was supplied
 *   - the target file IS a test file (allow editing tests freely)
 *   - the target file is outside `src/**` (not application code under our
 *     ambit — e.g. docs, config, fixtures)
 *   - at least one candidate companion test path exists on disk, OR
 *   - at least one candidate companion test path appears in
 *     `record.files_changed` in this session (bootstrap-batch escape)
 *
 * The bootstrap-batch escape is critical: a single task that creates BOTH
 * a new test file and the implementation in successive tool calls must not
 * deadlock. Once the test file write lands and PostToolUse records it in
 * `files_changed`, the next implementation Write is unblocked.
 */

import { existsSync } from "node:fs"
import { basename, dirname, extname, sep } from "node:path"
import type { PolicyDecision } from "./types.ts"

export interface TddGateInput {
  readonly enabled: boolean
  readonly toolName: string
  readonly resolvedFilePath: string | null
  readonly filesChangedInSession: ReadonlyArray<string>
}

export type TddVerdict = PolicyDecision

const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Update",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
])

/** Recognized "is this a test file?" suffixes. Conservative — matches the
 * codebase's own test layout. */
const TEST_FILE_SUFFIXES: ReadonlyArray<string> = [
  ".test.ts",
  ".test.tsx",
  ".test.js",
  ".test.jsx",
  ".test.mjs",
  ".spec.ts",
  ".spec.tsx",
  ".spec.js",
  ".spec.jsx",
]

/** Path segments that mark a directory as test territory. */
const TEST_DIR_SEGMENTS: ReadonlyArray<string> = ["test", "tests", "__tests__"]

export const isTestFilePath = (filePath: string): boolean => {
  const lower = filePath.toLowerCase()
  if (TEST_FILE_SUFFIXES.some((s) => lower.endsWith(s))) return true
  const parts = filePath.split(sep).filter((p) => p.length > 0)
  return parts.some((seg) => TEST_DIR_SEGMENTS.includes(seg))
}

/** True if the path is under a `src` directory anywhere in its prefix.
 * The TDD gate scopes to application code only. */
const isUnderSrc = (filePath: string): boolean => {
  const parts = filePath.split(sep)
  return parts.includes("src")
}

/**
 * Given a source-file path, return the set of plausible companion test
 * paths. The gate passes if any one exists on disk OR appears in the
 * session's `files_changed` ledger.
 *
 * For `<root>/src/foo/bar.ts` candidates include:
 *   - `<root>/test/foo/bar.test.ts`
 *   - `<root>/src/foo/bar.test.ts`
 *   - `<root>/src/foo/__tests__/bar.test.ts`
 *
 * Variants also emitted with `.spec.<ext>` and matching extensions where
 * applicable. List is small — intentionally limited to the patterns this
 * repo actually uses.
 */
export const inferTestPaths = (srcPath: string): ReadonlyArray<string> => {
  const ext = extname(srcPath)
  if (!ext.startsWith(".") || ext.length < 3) return []
  const base = basename(srcPath, ext)
  if (base.length === 0) return []
  const dir = dirname(srcPath)

  // Build candidate file names by extension.
  const testExtensions: ReadonlyArray<string> = ext === ".tsx"
    ? [".test.tsx", ".test.ts", ".spec.tsx", ".spec.ts"]
    : ext === ".jsx"
      ? [".test.jsx", ".test.js", ".spec.jsx", ".spec.js"]
      : ext === ".js" || ext === ".mjs" || ext === ".cjs"
        ? [".test.js", ".spec.js"]
        : [".test.ts", ".spec.ts"]

  const candidates = new Set<string>()
  for (const tExt of testExtensions) {
    // Inline: src/foo/bar.test.ts
    candidates.add(`${dir}${sep}${base}${tExt}`)
    // Under __tests__/: src/foo/__tests__/bar.test.ts
    candidates.add(`${dir}${sep}__tests__${sep}${base}${tExt}`)
    // Sibling test/ tree: replace the FIRST `src` segment with `test`.
    const mirrored = mirrorSrcToTest(dir)
    if (mirrored !== null) {
      candidates.add(`${mirrored}${sep}${base}${tExt}`)
    }
  }
  return Array.from(candidates)
}

const mirrorSrcToTest = (dir: string): string | null => {
  const parts = dir.split(sep)
  const idx = parts.indexOf("src")
  if (idx === -1) return null
  const next = [...parts]
  next[idx] = "test"
  return next.join(sep)
}

/**
 * Pure decision: given facts, return a PolicyDecision. No I/O. Tests can
 * drive this directly without filesystem setup.
 */
export const evaluateTddGateShallow = (
  input: TddGateInput,
  testFileExistsOnDisk: (path: string) => boolean,
): PolicyDecision => {
  if (!input.enabled) return { kind: "passthrough" }
  if (!WRITE_TOOLS.has(input.toolName)) return { kind: "passthrough" }
  if (input.resolvedFilePath === null) return { kind: "passthrough" }
  if (isTestFilePath(input.resolvedFilePath)) return { kind: "passthrough" }
  if (!isUnderSrc(input.resolvedFilePath)) return { kind: "passthrough" }

  const candidates = inferTestPaths(input.resolvedFilePath)
  if (candidates.length === 0) return { kind: "passthrough" }

  const changedSet = new Set(input.filesChangedInSession)
  const inSession = candidates.some((p) => changedSet.has(p))
  if (inSession) {
    return {
      kind: "allow",
      reason: "TDD gate: a matching test file was touched in this session.",
    }
  }

  const onDisk = candidates.some((p) => testFileExistsOnDisk(p))
  if (onDisk) {
    return {
      kind: "allow",
      reason: "TDD gate: a matching test file exists on disk.",
    }
  }

  return {
    kind: "deny",
    reason: tddDenyReason(input.resolvedFilePath, candidates),
  }
}

const tddDenyReason = (
  srcPath: string,
  candidates: ReadonlyArray<string>,
): string => {
  const sample = candidates.slice(0, 3)
  const lines = sample.map((p) => `  - ${p}`).join("\n")
  return (
    `TDD gate: writing ${srcPath} is blocked because no companion test ` +
    `was found or touched in this session.\n\n` +
    `Create or touch one of:\n${lines}\n\n` +
    `Then retry the write. To disable this gate, unset ` +
    `CLAUDE_HOOKS_TDD_GATE_ENABLED.`
  )
}

/**
 * Deep entry point: filesystem-backed. Pass-through to the shallow form
 * with `existsSync` as the disk check.
 */
export const evaluateTddGate = (input: TddGateInput): PolicyDecision =>
  evaluateTddGateShallow(input, (p) => existsSync(p))
