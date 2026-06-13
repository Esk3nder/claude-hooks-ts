/** Per-run state + signed verdicts + ledger (BUILD-SPEC §3.1, §5.4, §5.5). */
import { createHmac } from "node:crypto"
import { join } from "node:path"
import { statSync, renameSync, appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs"
import { stateRoot, writeHookOnly, readHookOnly, withLock } from "./fsx.ts"
import type { Outcome, Role } from "./types.ts"
import type { NodeAuthority } from "./recursion.ts"

export interface RunState {
  schema_version: 1
  session_id: string
  run_id: string
  agent_id: string
  parent_run_id: string | null
  agent_type: Role
  depth: number
  ancestry_labels: string[]
  authority: NodeAuthority
  state: "RUNNING" | "TERMINAL"
  brief_snapshot: Record<string, unknown> | null
  warm: boolean
  blocks_used: number
  terminal_outcome: Outcome | null
  last_event_seq: number
  panel_id: string | null
}

const safe = (s: string) => s.replace(/[^\w./-]/g, "_").slice(0, 200).replace(/\//g, "__")
function runStatePath(p: string, sess: string, runId: string) { return join(stateRoot(p), "runs", "state", sess, `${safe(runId)}.json`) }
function verdictPath(p: string, sess: string, runId: string) { return join(stateRoot(p), "runs", "verdicts", sess, `${safe(runId)}.json`) }
function secretPath(p: string) { return join(stateRoot(p), "session-secret") }

export function sessionSecret(project: string): string {
  const path = secretPath(project)
  const existing = readHookOnly(path)
  if (existing) return existing
  const secret = createHmac("sha256", String(process.hrtime.bigint())).update("cw-session").digest("hex")
  writeHookOnly(path, secret)
  return secret
}

export function saveRun(project: string, s: RunState): void {
  writeHookOnly(runStatePath(project, s.session_id, s.run_id), JSON.stringify(s, null, 2))
}
export function loadRun(project: string, sess: string, runId: string): RunState | null {
  const raw = readHookOnly(runStatePath(project, sess, runId))
  if (raw === null) return null
  try { const s = JSON.parse(raw) as RunState; return s.schema_version === 1 ? s : null } catch { return null }
}

export interface Verdict {
  schema_version: 1
  run_id: string
  agent_id: string
  role: Role
  outcome: Outcome
  trust_label: "verified" | "sampled" | "none"
  summary_line: string
  evidence: Record<string, unknown>
  advice: string
  sig?: string
}

function canonical(v: Omit<Verdict, "sig">): string {
  return JSON.stringify(v)
}
export function signVerdict(project: string, v: Omit<Verdict, "sig">): Verdict {
  const sig = createHmac("sha256", sessionSecret(project)).update(canonical(v)).digest("hex")
  return { ...v, sig }
}
export function verifyVerdict(project: string, v: Verdict): boolean {
  if (!v.sig) return false
  const { sig, ...body } = v
  const expect = createHmac("sha256", sessionSecret(project)).update(canonical(body as Omit<Verdict, "sig">)).digest("hex")
  return sig === expect
}
export function saveVerdict(project: string, sess: string, v: Verdict): void {
  writeHookOnly(verdictPath(project, sess, v.run_id), JSON.stringify(v, null, 2))
}
export function loadVerdict(project: string, sess: string, runId: string): Verdict | null {
  const raw = readHookOnly(verdictPath(project, sess, runId))
  if (raw === null) return null
  try { return JSON.parse(raw) as Verdict } catch { return null }
}

/** Append-only ledger with lock + rotation. */
export async function appendLedger(project: string, stream: string, row: object, maxBytes = 10_485_760): Promise<void> {
  const path = join(stateRoot(project), "eventstore", `${stream}.jsonl`)
  mkdirSync(join(stateRoot(project), "eventstore"), { recursive: true })
  await withLock(path, () => {
    try { if (statSync(path).size >= maxBytes) renameSync(path, `${path}.${process.pid}-${process.hrtime.bigint()}.rotated`) } catch { /* none */ }
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n")
  })
}

/** Count concurrent (RUNNING, non-terminal) runs in a session — for recursion caps. */
export function concurrentRuns(project: string, sess: string): number {
  const dir = join(stateRoot(project), "runs", "state", sess)
  if (!existsSync(dir)) return 0
  let n = 0
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue
      try { const s = JSON.parse(readFileSync(join(dir, f), "utf8")) as RunState; if (s.state === "RUNNING") n++ } catch { /* skip */ }
    }
  } catch { /* none */ }
  return n
}
