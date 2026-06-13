/** Pure result/brief validation (BUILD-SPEC §5; layer-map: rules live in policies, not schema). */
import {
  type WorkerBrief, type ImplementerResult, type ScoutResult, type SkepticResult,
  type Validation, type Role, ROLES, ok, err,
} from "./types.ts"

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const strArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string")

export function isSafeRelPath(p: unknown): boolean {
  if (typeof p !== "string" || p.length === 0) return false
  if (p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false
  return !p.split("/").some((s) => s === ".." || s === "")
}

export function extractJson(msg: string, maxBytes: number): Validation<Record<string, unknown>> {
  if (Buffer.byteLength(msg, "utf8") > maxBytes) return err([`message exceeds ${maxBytes} bytes`])
  const tryParse = (s: string) => { try { const v = JSON.parse(s); return isObj(v) ? v : null } catch { return null } }
  const direct = tryParse(msg.trim())
  if (direct) return ok(direct)
  const fences = [...msg.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)]
  if (fences.length === 1) { const f = tryParse(fences[0]![1]!.trim()); if (f) return ok(f) }
  if (fences.length > 1) return err(["multiple fenced blocks; emit exactly one JSON object"])
  return err(["not a JSON object (or one fenced JSON block)"])
}

export function validateBrief(v: unknown): Validation<WorkerBrief> {
  if (!isObj(v)) return err(["brief is not an object"])
  const e: string[] = []
  if (v["schema_version"] !== 1) e.push("schema_version must be 1")
  const role = v["role"]
  if (!ROLES.includes(role as Role)) e.push(`role must be ${ROLES.join("|")}`)
  if (typeof v["label"] !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(v["label"] as string))
    e.push("label must be kebab-case ≤64")
  const isc = v["isc_id"]
  const spine = isc !== undefined && isc !== null
  const acc = v["acceptance"]
  if (spine) {
    if (role === "scout") e.push("scout briefs may not be spine-linked (§5.1)")
    if (!isObj(acc) || acc["replay"] !== "required" || acc["idempotent"] !== true)
      e.push("spine briefs require acceptance.replay=required and idempotent=true (§5.1)")
  }
  if (v["warm"] === true && role !== "implementer") e.push("warm requires role implementer (§5.1)")
  const strat = v["strategy"]
  if (isObj(strat) && typeof strat["k"] === "number" && (strat["k"] as number) > 1) {
    if (strat["mode"] !== "speculative") e.push("k>1 requires strategy.mode=speculative")
    if (role !== "implementer") e.push("speculative requires role implementer")
  }
  if (v["lens"] !== undefined && v["lens"] !== null && role !== "skeptic") e.push("lens only for skeptic")
  if (isObj(acc)) {
    if (!strArr(acc["argv"]) || (acc["argv"] as string[]).length === 0) e.push("acceptance.argv must be non-empty")
    if (acc["idempotent"] === false && acc["replay"] !== "none") e.push("non-idempotent acceptance requires replay:none")
  }
  return e.length ? err(e) : ok(v as unknown as WorkerBrief)
}

export function validateImplementerResult(v: Record<string, unknown>): Validation<ImplementerResult> {
  const e: string[] = []
  const status = v["status"]
  if (status !== "done" && status !== "blocked") e.push('status must be "done"|"blocked"')
  if (typeof v["label"] !== "string") e.push("label (string) required, must match brief")
  if (typeof v["summary"] !== "string") e.push("summary required")
  const ws = v["workspace"]
  if (!isObj(ws)) e.push("workspace required")
  else if (status === "done" && (typeof ws["root"] !== "string" || !(ws["root"] as string).startsWith("/")))
    e.push("workspace.root (absolute) required for status done")
  if (!strArr(v["changed_files"])) e.push("changed_files (string[]) required")
  else (v["changed_files"] as string[]).forEach((p, i) => { if (!isSafeRelPath(p)) e.push(`changed_files[${i}] unsafe path`) })
  if (!strArr(v["blockers"])) e.push("blockers (string[]) required")
  const blockers = strArr(v["blockers"]) ? (v["blockers"] as string[]) : []
  const ver = v["verification"]
  if (status === "done") {
    if (blockers.length) e.push("status done requires empty blockers")
    if (!isObj(ver)) e.push("status done requires verification{argv,cwd,exit_code}")
    else {
      if (!strArr(ver["argv"]) || (ver["argv"] as string[]).length === 0) e.push("verification.argv required")
      if (ver["exit_code"] !== 0) e.push("status done requires verification.exit_code===0")
      if (typeof ver["cwd"] !== "string") e.push("verification.cwd required")
    }
  }
  if (status === "blocked" && blockers.length === 0) e.push("status blocked requires non-empty blockers")
  return e.length ? err(e) : ok(v as unknown as ImplementerResult)
}

export function validateSkepticResult(v: Record<string, unknown>): Validation<SkepticResult> {
  const e: string[] = []
  if (typeof v["label"] !== "string") e.push("label required")
  if (typeof v["claim"] !== "string") e.push("claim required")
  if (!["confirmed", "refuted", "inconclusive"].includes(v["verdict"] as string)) e.push("verdict must be confirmed|refuted|inconclusive")
  const ws = v["workspace"]
  if (!isObj(ws) || typeof ws["root"] !== "string" || !(ws["root"] as string).startsWith("/"))
    e.push("workspace.root (absolute) required — drift target")
  if (!strArr(v["caveats"])) e.push("caveats (string[]) required")
  const caveats = strArr(v["caveats"]) ? (v["caveats"] as string[]) : []
  const hasEv = Array.isArray(v["evidence"]) && (v["evidence"] as unknown[]).length > 0
  const repro = v["reproduction"]
  if (v["verdict"] === "refuted" && !hasEv && !isObj(repro)) e.push("refuted requires evidence or reproduction")
  if (v["verdict"] === "confirmed" && caveats.length === 0) e.push("confirmed requires caveats")
  if (v["verdict"] === "inconclusive" && caveats.length === 0) e.push("inconclusive requires caveats")
  return e.length ? err(e) : ok(v as unknown as SkepticResult)
}

export function validateScoutResult(v: Record<string, unknown>): Validation<ScoutResult> {
  const e: string[] = []
  if (typeof v["label"] !== "string") e.push("label required")
  if (typeof v["question"] !== "string") e.push("question required")
  const f = v["findings"]
  if (!Array.isArray(f)) e.push("findings must be array")
  else f.forEach((it, i) => {
    if (!isObj(it)) return e.push(`findings[${i}] not object`)
    if (!Array.isArray(it["evidence"]) || (it["evidence"] as unknown[]).length === 0) e.push(`findings[${i}].evidence non-empty required`)
    if (!["high", "medium", "low"].includes(it["confidence"] as string)) e.push(`findings[${i}].confidence invalid`)
  })
  const cov = v["coverage"]
  if (!isObj(cov) || !strArr(cov["examined"]) || !strArr(cov["not_examined"])) e.push("coverage.{examined,not_examined} required")
  if (!strArr(v["unknowns"])) e.push("unknowns (string[]) required")
  if (Array.isArray(f) && f.length === 0 && strArr(v["unknowns"]) && (v["unknowns"] as string[]).length === 0)
    e.push("empty findings require non-empty unknowns")
  return e.length ? err(e) : ok(v as unknown as ScoutResult)
}
