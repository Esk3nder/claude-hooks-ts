/** Session-start trust baseline (BUILD-SPEC §2.1, fix #1). user_pinned ≡ committed-clean at session start. */
import { createHash } from "node:crypto"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { stateRoot, writeHookOnly, readHookOnly } from "./fsx.ts"

export interface Baseline {
  schema_version: 1
  session_id: string
  created_at: string
  git_head: string | null
  git_clean: boolean
  trusted_files: Record<string, { sha256: string; committed: boolean }>
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}
function baselinePath(project: string): string {
  return join(stateRoot(project), "baseline.json")
}

function gitTrackedClean(project: string, rel: string): boolean {
  // committed & not dirty in the working tree
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", rel], { cwd: project, stdio: "ignore" })
  if (tracked.status !== 0) return false
  const dirty = spawnSync("git", ["diff", "--quiet", "HEAD", "--", rel], { cwd: project })
  return dirty.status === 0
}

/** Written once at SessionStart, BEFORE any model action. */
export function writeBaseline(project: string, sessionId: string, candidatePaths: string[]): Baseline {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" })
  const clean = spawnSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8" })
  const trusted: Baseline["trusted_files"] = {}
  for (const rel of candidatePaths) {
    const abs = join(project, rel)
    if (!existsSync(abs)) continue
    let content = ""
    try { content = readFileSync(abs, "utf8") } catch { continue }
    trusted[rel] = { sha256: sha256(content), committed: gitTrackedClean(project, rel) }
  }
  const baseline: Baseline = {
    schema_version: 1,
    session_id: sessionId,
    created_at: new Date().toISOString(),
    git_head: head.status === 0 ? head.stdout.trim() : null,
    git_clean: clean.status === 0 ? clean.stdout.trim().length === 0 : false,
    trusted_files: trusted,
  }
  writeHookOnly(baselinePath(project), JSON.stringify(baseline, null, 2))
  return baseline
}

export function loadBaseline(project: string): Baseline | null {
  const raw = readHookOnly(baselinePath(project))
  if (raw === null) return null
  try { const b = JSON.parse(raw) as Baseline; return b.schema_version === 1 ? b : null } catch { return null }
}

/**
 * A file is user-pinned iff it is in the baseline with committed:true AND unchanged since.
 * A model edit mid-session (hash drift) or a file absent from the baseline is NOT user-pinned.
 */
export function isUserPinned(project: string, rel: string): boolean {
  const b = loadBaseline(project)
  if (b === null) return false
  const entry = b.trusted_files[rel]
  if (!entry || !entry.committed) return false
  try {
    return sha256(readFileSync(join(project, rel), "utf8")) === entry.sha256
  } catch {
    return false
  }
}
