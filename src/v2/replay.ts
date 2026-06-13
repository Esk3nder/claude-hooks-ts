/** Safe replay executor (BUILD-SPEC §13, constitution §6.3). Pinned argv, env-replace, detached pgroup, cwd-confine. */
import { spawn } from "node:child_process"
import { realpathSync, statSync } from "node:fs"
import { resolve, sep } from "node:path"
import { evalBashSafety } from "./gates.ts"
import type { WorkerBrief } from "./types.ts"
import type { AllowedArgv } from "./config.ts"

export function argvEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

// interpreter basenames incl. versioned python (python3.12) — N6
const INTERP_RE = /^(?:python\d?(?:\.\d+)?|node|bun|deno|ruby|perl|php|Rscript|sh|bash|zsh|ksh|csh|tcsh|fish|dash)$/
const INLINE_CODE_FLAG = /^-(?:c|e|-eval|-command)$/

/** Effective interpreter, unwrapping an `env [VAR=val|-flags] <cmd>` prefix that hides it (N6). */
function effectiveInterp(argv: string[]): { interp: string; rest: string[] } {
  let i = 0
  let base = (argv[0] ?? "").split("/").pop() ?? ""
  if (base === "env") {
    i = 1
    while (i < argv.length && (/^[A-Za-z_]\w*=/.test(argv[i]!) || argv[i]!.startsWith("-"))) i++
    base = (argv[i] ?? "").split("/").pop() ?? ""
  }
  return { interp: base, rest: argv.slice(i + 1) }
}

/**
 * Safety check over a replay's pinned argv (constitution §6.3, F5). A pin can come from a
 * MODEL-authored brief (acceptance/allowed_reproduction), so even though replay is argv-only
 * (no shell), cwd-confined, and env-replaced, the argv itself can still be destructive
 * (`git push --force main`, recursive absolute delete, writes to a secret path) or hand control
 * to an interpreter running inline code (`python -c …`, `env python3.12 -c …`). Reject those.
 * Bound (honest): a benign file write inside the confined workspace (e.g. `touch x`) is allowed —
 * the threat model accepts the worker mutating its own workspace; this gate stops escape/destruction.
 */
export function evalReplayArgvSafety(argv: string[]): { ok: boolean; reason?: string } {
  if (argv.length === 0) return { ok: false, reason: "empty replay argv" }
  const { interp, rest } = effectiveInterp(argv)
  if (INTERP_RE.test(interp) && rest.some((x) => INLINE_CODE_FLAG.test(x)))
    return { ok: false, reason: `replay argv runs inline interpreter code (${interp} -c/-e)` }
  const d = evalBashSafety(argv.join(" "))
  if (d.kind === "deny") return { ok: false, reason: `unsafe replay argv: ${d.reason}` }
  return { ok: true }
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
