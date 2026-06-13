/** Brief registration + content snapshot trust (BUILD-SPEC §2, §5.1, fixes #1/#3/#4 TOCTOU). */
import { join } from "node:path"
import { stateRoot, confine, readHookOnly } from "./fsx.ts"
import { readFileSync } from "node:fs"
import { openSync, readSync, closeSync, statSync, constants as C } from "node:fs"
import { validateBrief } from "./validate.ts"
import type { WorkerBrief } from "./types.ts"

export function briefsDir(project: string): string {
  return join(stateRoot(project), "briefs")
}

/** Read a model-authorable brief by label: confined under briefs/, O_NOFOLLOW (reject symlinks). */
export function loadBrief(project: string, label: string): { brief: WorkerBrief | null; raw: string | null; reason: string } {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(label)) return { brief: null, raw: null, reason: "invalid label" }
  const abs = confine(briefsDir(project), `${label}.json`)
  if (abs === null) return { brief: null, raw: null, reason: "path escape" }
  let fd: number | null = null
  let raw: string
  try {
    fd = openSync(abs, C.O_RDONLY | C.O_NOFOLLOW)
    const st = statSync(abs)
    if (!st.isFile()) return { brief: null, raw: null, reason: "not a regular file (symlink?)" }
    const buf = Buffer.alloc(st.size); readSync(fd, buf, 0, st.size, 0); raw = buf.toString("utf8")
  } catch (e) {
    return { brief: null, raw: null, reason: `open failed (symlink/missing): ${String(e).slice(0, 60)}` }
  } finally {
    if (fd !== null) try { closeSync(fd) } catch { /* ignore */ }
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return { brief: null, raw, reason: "invalid JSON" } }
  const v = validateBrief(parsed)
  if (!v.ok) return { brief: null, raw, reason: v.errors.join("; ") }
  return { brief: v.value, raw, reason: "ok" }
}

export type BriefTrust = "registered" | "untrusted" | "missing"

/**
 * Trust model: the brief CONTENT is snapshotted into run state at SubagentStart.
 * - snapshot present  ⇒ "registered" (captured before the worker could run; replay/flip use the snapshot)
 * - snapshot absent, live file present ⇒ "untrusted" (appeared after start — possible forgery)
 * - both absent ⇒ "missing"
 */
export function briefTrust(snapshot: Record<string, unknown> | null, liveRaw: string | null): BriefTrust {
  if (snapshot !== null) return "registered"
  if (liveRaw !== null) return "untrusted"
  return "missing"
}

export function briefFromSnapshot(snapshot: Record<string, unknown> | null): WorkerBrief | null {
  if (snapshot === null) return null
  const v = validateBrief(snapshot)
  return v.ok ? v.value : null
}
