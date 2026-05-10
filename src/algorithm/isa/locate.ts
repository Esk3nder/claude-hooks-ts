/**
 * ISA filesystem locator — port of this package's `~/.claude/hooks/lib/isa-utils.ts`
 * lines 22-68 with one path adaptation called out below.
 *
 * Functions ported (verbatim semantics):
 * - findArtifactPath(slug) — the classifier
 * - findLatestISA(root?) — the classifier
 *
 * Functions added (NEW DESIGN, doctrine line 56-57 of IsaFormat.md):
 * - findProjectIsa(cwd) — `<project>/ISA.md` at the repo root, the
 * second canonical home for project ISAs
 * - isIsaFilePath(path) — does this absolute path point to an ISA?
 *
 * Path layout:
 * - Canonical (writable): `<repo>/.claude-hooks/work/<slug>/ISA.md`. Lives
 *   OUTSIDE `.claude-hooks/state/` so task ISAs are tracked by git as
 *   evidence trails. The `root` parameter overrides the default for
 *   tests and for tools that operate against a specific project root.
 * - Legacy (read-only fallback): `<repo>/.claude-hooks/state/work/<slug>/`.
 *   Pre-Option-B installs wrote here; locator readers continue to scan
 *   it so in-flight sessions keep working through the migration. New
 *   ISAs are never written here.
 * - Legacy PRD.md filename fallback is preserved: pre-v4.1.0 ISAs lived
 *   under `PRD.md`. Read-only, both dirs.
 */

import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * Canonical artifact filename. The classifier verbatim. Algorithm v4.1.0
 * renamed PRD → ISA; the legacy fallback is read-only.
 */
export const ARTIFACT_FILENAME = "ISA.md"

/** the classifier verbatim — pre-v4.1.0 sessions still ship PRD.md. */
export const LEGACY_ARTIFACT_FILENAME = "PRD.md"

/**
 * Default (canonical) work-directory path relative to a project root.
 * Lives at `.claude-hooks/work/` — OUTSIDE `.claude-hooks/state/` so
 * task ISAs are tracked by git as evidence trails. State (per-session
 * JSON, locks, telemetry) stays under `.claude-hooks/state/` and remains
 * gitignored.
 */
const WORK_SUBPATH = [".claude-hooks", "work"] as const

/**
 * Legacy work-directory path. Pre-Option-B installs wrote task ISAs at
 * `.claude-hooks/state/work/`, which was caught by the `.gitignore` on
 * `.claude-hooks/state/` and lost their evidence-trail value. Locator
 * functions read from this path as a fallback so already-running
 * sessions keep working through the migration; new ISAs always write
 * to the canonical path above.
 */
const LEGACY_WORK_SUBPATH = [".claude-hooks", "state", "work"] as const

/** Compute the canonical (tracked) work directory for a given project root. */
export const workDirFor = (root: string = process.cwd()): string =>
  join(root, ...WORK_SUBPATH)

/** Compute the legacy (gitignored) work directory for a given project root.
 *  Used by readers as a fallback when no artifact exists at the canonical
 *  path. Writers should NEVER target this directory. */
export const legacyWorkDirFor = (root: string = process.cwd()): string =>
  join(root, ...LEGACY_WORK_SUBPATH)

/**
 * Resolve the ideal-state artifact path for a session slug. Read order:
 *   1. `<canonical>/<slug>/ISA.md`     (new tracked location)
 *   2. `<canonical>/<slug>/PRD.md`     (canonical legacy filename)
 *   3. `<legacy>/<slug>/ISA.md`        (pre-Option-B path)
 *   4. `<legacy>/<slug>/PRD.md`        (pre-Option-B + pre-v4.1.0)
 * Returns null if none exist.
 */
export const findArtifactPath = (
  slug: string,
  root: string = process.cwd(),
): string | null => {
  const candidates = [
    join(workDirFor(root), slug, ARTIFACT_FILENAME),
    join(workDirFor(root), slug, LEGACY_ARTIFACT_FILENAME),
    join(legacyWorkDirFor(root), slug, ARTIFACT_FILENAME),
    join(legacyWorkDirFor(root), slug, LEGACY_ARTIFACT_FILENAME),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/**
 * Scan both canonical and legacy work directories for the most-recently-
 * modified artifact across all session slugs. Prefers `ISA.md` per
 * directory, falls back to legacy `PRD.md`. Returns null when no
 * artifacts exist anywhere.
 *
 * Best-effort: per-directory stat errors are swallowed so one corrupt
 * entry doesn't poison the scan.
 */
export const findLatestISA = (root: string = process.cwd()): string | null => {
  const slugSeen = new Set<string>()
  let latest: string | null = null
  let latestMtime = 0
  for (const workDir of [workDirFor(root), legacyWorkDirFor(root)]) {
    if (!existsSync(workDir)) continue
    let entries: ReadonlyArray<string>
    try {
      entries = readdirSync(workDir)
    } catch {
      continue
    }
    for (const slug of entries) {
      // Same slug under both dirs → prefer canonical (already evaluated
      // since we iterate canonical first). Skip the legacy duplicate.
      if (slugSeen.has(slug)) continue
      slugSeen.add(slug)
      const candidate = findArtifactPath(slug, root)
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
  }
  return latest
}

/**
 * Locate the project ISA — `<root>/ISA.md` — when the repo carries one.
 * Project ISAs are the second canonical home from `IsaFormat.md` lines
 * 56-57: a thing with persistent identity (application, CLI tool, library,
 * the Algorithm itself) keeps its ISA at the project root as system of
 * record.
 *
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
 * implements canonical behavior ISASync.hook.ts lines 44-46 detection logic: matches
 * either filename at the path's tail, regardless of which directory the
 * file lives in (project root, MEMORY/WORK/, .claude-hooks/work/, the
 * legacy .claude-hooks/state/work/, or a user-defined location).
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
