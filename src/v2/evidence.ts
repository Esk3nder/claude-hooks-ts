/** Evidence graph: flip records its dependencies; later change invalidates (BUILD-SPEC §4, fix #2). */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { stateRoot, writeHookOnly, readHookOnly } from "./fsx.ts"

export interface EvidenceGraph {
  schema_version: 1
  isc_id: string
  isa_path: string
  flipped_at: string
  flip_source: "replay" | "manual"
  user_pinned: boolean
  trust_label: "verified" | "sampled"
  depends_on: { argv: string[]; argv_pin: string; env_hash: string; cwd: string; file_scope: Record<string, string>; git_head: string | null }
  status: "valid" | "stale"
  confirmation: string | null
}

function evPath(project: string, session: string, isc: string): string {
  return join(stateRoot(project), "evidence", session, `${isc}.json`)
}
function hashFile(project: string, rel: string): string {
  try { return createHash("sha256").update(readFileSync(join(project, rel), "utf8")).digest("hex") } catch { return "MISSING" }
}

export function hashScope(project: string, files: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of [...new Set(files)]) out[f] = hashFile(project, f)
  return out
}

export function writeEvidence(project: string, session: string, g: EvidenceGraph): void {
  writeHookOnly(evPath(project, session, g.isc_id), JSON.stringify(g, null, 2))
}
export function loadEvidence(project: string, session: string, isc: string): EvidenceGraph | null {
  const raw = readHookOnly(evPath(project, session, isc))
  if (raw === null) return null
  try { return JSON.parse(raw) as EvidenceGraph } catch { return null }
}

/** Recompute file_scope hashes; mismatch ⇒ stale. Run at Stop and at phase:complete. Returns the (possibly updated) status. */
export function revalidate(project: string, session: string, isc: string): "valid" | "stale" | "absent" {
  const g = loadEvidence(project, session, isc)
  if (g === null) return "absent"
  if (g.status === "stale") return "stale"
  for (const [f, h] of Object.entries(g.depends_on.file_scope)) {
    if (hashFile(project, f) !== h) { g.status = "stale"; writeEvidence(project, session, g); return "stale" }
  }
  return "valid"
}
