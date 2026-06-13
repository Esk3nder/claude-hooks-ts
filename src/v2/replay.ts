/** Safe replay executor (BUILD-SPEC §13, constitution §6.3). Pinned argv, env-replace, detached pgroup, cwd-confine. */
import { spawn } from "node:child_process"
import { realpathSync, statSync } from "node:fs"
import { resolve, sep } from "node:path"
import type { WorkerBrief } from "./types.ts"
import type { AllowedArgv } from "./config.ts"

export function argvEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

export interface Pin { argv: string[]; cwd: string; risk: "low" | "high" }

/** Resolve a pin for a claimed argv: trusted-brief acceptance/reproduction or project allowlist. Never worker-chosen. */
export function resolvePin(claimed: string[], trustedBrief: WorkerBrief | null, allowlist: AllowedArgv[]): Pin | null {
  const acc = trustedBrief?.acceptance
  if (acc && argvEqual(acc.argv, claimed)) return { argv: acc.argv, cwd: acc.cwd, risk: trustedBrief?.risk ?? "low" }
  for (const rep of trustedBrief?.allowed_reproduction ?? [])
    if (argvEqual(rep.argv, claimed)) return { argv: rep.argv, cwd: rep.cwd, risk: "low" }
  for (const a of allowlist) if (argvEqual(a.argv, claimed)) return { argv: a.argv, cwd: ".", risk: a.risk }
  return null
}

export function resolveWorkspace(root: string, cwd: string): { ok: boolean; absCwd: string; detail: string } {
  try {
    if (!root.startsWith("/")) return { ok: false, absCwd: "", detail: "root must be absolute" }
    const realRoot = realpathSync(root)
    if (!statSync(realRoot).isDirectory()) return { ok: false, absCwd: "", detail: "root not a dir" }
    const realCwd = realpathSync(resolve(realRoot, cwd))
    if (realCwd !== realRoot && !realCwd.startsWith(realRoot + sep)) return { ok: false, absCwd: "", detail: "cwd escapes workspace" }
    return { ok: true, absCwd: realCwd, detail: "ok" }
  } catch (e) {
    return { ok: false, absCwd: "", detail: `resolve failed: ${String(e).slice(0, 120)}` }
  }
}

export function minimalEnv(envAllow: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of ["PATH", "HOME", "LANG", "TMPDIR", ...envAllow]) {
    const v = process.env[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

export interface ReplayExec { ran: boolean; exitCode: number | null; timedOut: boolean; tail: string; ms: number; detail: string }

export function executeReplay(pin: Pin, absCwd: string, o: { timeoutMs: number; maxBytes: number; envAllow: string[] }): Promise<ReplayExec> {
  return new Promise((res) => {
    const started = Date.now()
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(pin.argv[0]!, pin.argv.slice(1), { cwd: absCwd, env: minimalEnv(o.envAllow), detached: true, stdio: ["ignore", "pipe", "pipe"] })
    } catch (e) {
      return res({ ran: false, exitCode: null, timedOut: false, tail: "", ms: 0, detail: `spawn failed: ${String(e).slice(0, 120)}` })
    }
    let out = ""
    const cap = (c: Buffer) => { out += c.toString("utf8"); if (out.length > 64_000) out = out.slice(-64_000) }
    child.stdout?.on("data", cap); child.stderr?.on("data", cap)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid!, "SIGKILL") } catch { try { child.kill("SIGKILL") } catch { /* dead */ } }
    }, o.timeoutMs)
    child.on("error", (e) => { clearTimeout(timer); res({ ran: false, exitCode: null, timedOut: false, tail: "", ms: Date.now() - started, detail: String(e).slice(0, 120) }) })
    child.on("close", (code) => {
      clearTimeout(timer)
      res({ ran: true, exitCode: code, timedOut, tail: out.slice(-o.maxBytes), ms: Date.now() - started, detail: timedOut ? "killed on timeout (pgroup)" : "done" })
    })
  })
}
