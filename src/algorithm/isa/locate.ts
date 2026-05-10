/**
 * ISA filesystem locator. Two canonical homes for ISAs:
 *
 * - **Per-task ISAs** at `<repo>/.claude-hooks/state/work/<slug>/ISA.md` —
 *   one per discrete task. `findArtifactPath(slug)` resolves a single
 *   slug; `findLatestISA(root?)` returns the most-recently-modified one
 *   across all slugs.
 * - **Project ISAs** at `<repo>/ISA.md` — for things with persistent
 *   identity (an application, CLI tool, library, or this package's own
 *   Algorithm). Resolved by `findProjectIsa(cwd)`.
 *
 * `isIsaFilePath(path)` is a tail-only filename match used by PostToolUse
 * handlers to filter Edit/Write events to ISA targets regardless of
 * directory.
 *
 * Legacy `PRD.md` fallback is read-only: pre-v4.1.0 ISAs lived under
 * that filename. New ISAs always write `ISA.md`.
 */

import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/** Canonical artifact filename. Algorithm v4.1.0 renamed PRD → ISA. */
export const ARTIFACT_FILENAME = "ISA.md"

/** Read-only fallback for pre-v4.1.0 sessions. */
export const LEGACY_ARTIFACT_FILENAME = "PRD.md"

/**
 * Default work-directory path relative to a project root. Mirrors the
 * existing `.claude-hooks/state/...` convention used by
 * `services/session-state.ts:101` (`statePath`).
 */
const WORK_SUBPATH = [".claude-hooks", "state", "work"] as const

/** Compute the work directory for a given project root. */
export const workDirFor = (root: string = process.cwd()): string =>
  join(root, ...WORK_SUBPATH)

/**
 * Resolve the ideal-state artifact path for a session slug. Read order:
 * `ISA.md` (canonical) → `PRD.md` (legacy). Returns null if neither file
 * exists. Single read-fallback site for any caller that wants per-session
 * artifacts.
 */
export const findArtifactPath = (
  slug: string,
  root: string = process.cwd(),
): string | null => {
  const dir = join(workDirFor(root), slug)
  const isa = join(dir, ARTIFACT_FILENAME)
  if (existsSync(isa)) return isa
  const legacy = join(dir, LEGACY_ARTIFACT_FILENAME)
  if (existsSync(legacy)) return legacy
  return null
}

/**
 * Scan the work directory for the most-recently-modified artifact across
 * all session slugs. Prefers `ISA.md` per directory, falls back to legacy
 * `PRD.md`. Returns null when the work dir doesn't exist or contains no
 * artifacts.
 *
 * Best-effort: per-directory stat errors are swallowed so one corrupt
 * entry doesn't poison the scan.
 */
export const findLatestISA = (root: string = process.cwd()): string | null => {
  const workDir = workDirFor(root)
  if (!existsSync(workDir)) return null
  let latest: string | null = null
  let latestMtime = 0
  let entries: ReadonlyArray<string>
  try {
    entries = readdirSync(workDir)
  } catch {
    return null
  }
  for (const dir of entries) {
    const candidate = findArtifactPath(dir, root)
    if (candidate === null) continue
    try {
      const s = statSync(candidate)
      if (s.mtimeMs > latestMtime) {
        latestMtime = s.mtimeMs
        latest = candidate
      }
    } catch {
      // best-effort — skip unreadable entry
    }
  }
  return latest
}

/**
 * Locate the project ISA — `<root>/ISA.md` — when the repo carries one.
 * Returns null when no `ISA.md` exists at the root. Does NOT search up
 * (no `git rev-parse`-style ancestor walk) — caller passes the root
 * explicitly. The project-detection layer lives elsewhere.
 */
export const findProjectIsa = (root: string = process.cwd()): string | null => {
  const candidate = join(root, ARTIFACT_FILENAME)
  return existsSync(candidate) ? candidate : null
}

/**
 * Does `filePath` point to an ISA file (canonical or legacy)? Used by
 * PostToolUse handlers to filter Edit/Write events to ISA files only.
 *
 * Matches either filename at the path's tail, regardless of which
 * directory the file lives in (project root, .claude-hooks/state/work/,
 * or a user-defined location).
 */
export const isIsaFilePath = (filePath: string): boolean => {
  if (typeof filePath !== "string" || filePath.length === 0) return false
  return (
    filePath.endsWith(`/${ARTIFACT_FILENAME}`) ||
    filePath === ARTIFACT_FILENAME ||
    filePath.endsWith(`/${LEGACY_ARTIFACT_FILENAME}`) ||
    filePath === LEGACY_ARTIFACT_FILENAME
  )
}
