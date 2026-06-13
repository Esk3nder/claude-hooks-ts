/** The SubagentStop pipeline (BUILD-SPEC §3, §4, §6.2, §8): contract → drift → replay → evidence flip → signed verdict → ledger.
 * Idempotent terminal write via CAS under the run-state lock (fix #4). */
import { join } from "node:path"
import { stateRoot, withLock } from "./fsx.ts"
import { loadPolicy, type PolicyConfig } from "./config.ts"
import { loadBrief, briefTrust, briefFromSnapshot } from "./briefs.ts"
import {
  loadRun, saveRun, saveVerdict, signVerdict, appendLedger, type RunState, type Verdict,
} from "./runs.ts"
import {
  validateImplementerResult, validateScoutResult, validateSkepticResult, extractJson,
} from "./validate.ts"
import { checkDrift } from "./drift.ts"
import { resolvePin, resolveWorkspace, executeReplay } from "./replay.ts"
import { hashScope, writeEvidence, type EvidenceGraph } from "./evidence.ts"
import { isUserPinned, sha256 } from "./trust.ts"
import type { Outcome, Role, ImplementerResult, SkepticResult } from "./types.ts"

export interface StopInput {
  project: string
  session_id: string
  run_id: string
  event_seq: number
  last_assistant_message: string
  // simulated host facts:
  workspace_root?: string // where the worker ran (for drift); defaults to project
}

export interface StopResult { decision: "block" | "pass"; reason?: string; outcome?: Outcome }

const MAX_MSG = 262_144

export async function handleSubagentStop(inp: StopInput): Promise<StopResult> {
  const lockTarget = join(stateRoot(inp.project), "runs", "state", inp.session_id, `${inp.run_id.replace(/\//g, "__")}.json`)
  return withLock(lockTarget, async () => {
    const run = loadRun(inp.project, inp.session_id, inp.run_id)
    if (run === null) {
      // missing SubagentStart: soft_failed, never replay-from-disk
      await finalize(inp, null, "soft_failed", "no SubagentStart (missing run state)", { reason: "missing_start" }, "none")
      return { decision: "pass", outcome: "soft_failed" }
    }
    if (run.state === "TERMINAL") {
      // CAS idempotency: already terminal ⇒ no-op (no second ledger row / flip)
      return { decision: "pass", outcome: run.terminal_outcome ?? "soft_failed" }
    }
    const policy = loadPolicy(inp.project)
    const role = run.agent_type

    // 1. contract
    const json = extractJson(inp.last_assistant_message, MAX_MSG)
    const validated = json.ok
      ? role === "implementer" ? validateImplementerResult(json.value!)
      : role === "skeptic" ? validateSkepticResult(json.value!)
      : validateScoutResult(json.value!)
      : json
    if (!validated.ok) {
      if (run.blocks_used < 2) {
        run.blocks_used++; saveRun(inp.project, run)
        return { decision: "block", reason: `${role} contract invalid: ${validated.errors.join("; ")}. Emit corrected JSON only.` }
      }
      await finalize(inp, run, "soft_failed", `contract failed after blocks: ${validated.errors[0]}`, { contract_errors: validated.errors.slice(0, 6) }, "none")
      return { decision: "pass", outcome: "soft_failed" }
    }
    const result = validated.value as { label: string } & Record<string, unknown>
    // TOCTOU fix: the brief used for replay/flip is the SNAPSHOT captured at start, never re-read from disk.
    const trustedBrief = briefFromSnapshot(run.brief_snapshot)
    const live = loadBrief(inp.project, result.label)
    const trust = briefTrust(run.brief_snapshot, live.raw)

    // scout: well_formed, never spine
    if (role === "scout") {
      await finalize(inp, run, "well_formed", "schema-valid scout result", {}, "none")
      return { decision: "pass", outcome: "well_formed" }
    }

    // skeptic: drift first, then optional reproduction replay
    if (role === "skeptic") {
      const sk = result as unknown as SkepticResult
      const exempt = trust === "registered" ? (trustedBrief?.parent_run_id ? [] : []) : []
      const drift = checkDrift(sk.workspace.root, policy.drift.ignore, exempt)
      if (drift.verdict === "detected") {
        if (run.blocks_used < 2) { run.blocks_used++; saveRun(inp.project, run); return { decision: "block", reason: `workspace dirty: ${drift.changed.slice(0,8).join(", ")}. Clean up or explain.` } }
        await finalize(inp, run, "rejected", `drift after budget: ${drift.detail}`, { drift: drift.changed.slice(0, 20) }, "none")
        return { decision: "pass", outcome: "rejected" }
      }
      // reproduction replay if command
      const repro = sk.reproduction
      if (repro && Array.isArray(repro.argv)) {
        const r = await tryReplay(inp, run, trust, trustedBrief, repro.argv, sk.workspace.root, repro.cwd ?? ".", policy, repro.expected_exit_code ?? 0)
        if (r) return r
      }
      await finalize(inp, run, "accepted_verified", `skeptic ${sk.verdict}`, {}, "verified")
      return { decision: "pass", outcome: "accepted_verified" }
    }

    // implementer
    const impl = result as unknown as ImplementerResult
    if (impl.status === "blocked") {
      await finalize(inp, run, "accepted_verified", `blocked: ${impl.blockers[0] ?? ""}`.slice(0, 120), {}, "none")
      return { decision: "pass", outcome: "accepted_verified" }
    }
    const r = await tryReplay(inp, run, trust, trustedBrief, impl.verification!.argv, impl.workspace.root, impl.verification!.cwd, policy, 0)
    return r ?? { decision: "pass", outcome: "soft_failed" }
  })
}

/** Returns a StopResult if it terminated/blocked the run; null only when caller should continue. */
async function tryReplay(
  inp: StopInput, run: RunState, trust: string, brief: import("./types.ts").WorkerBrief | null,
  claimedArgv: string[], wsRoot: string, cwd: string, policy: PolicyConfig, expectExit: number,
): Promise<StopResult> {
  const isSpine = !!(brief?.isc_id)
  if (trust !== "registered") {
    await finalize(inp, run, "soft_failed", `replay skipped: brief ${trust}`, { brief: trust }, "none")
    return { decision: "pass", outcome: "soft_failed" }
  }
  if (brief?.acceptance?.replay === "none") {
    await finalize(inp, run, "soft_failed", "declared non-replayable (replay:none)", {}, "none")
    return { decision: "pass", outcome: "soft_failed" }
  }
  // spine flips require an allowlist-pinned argv, not a brief-authored one
  const pin = resolvePin(claimedArgv, brief, policy.replay.allowed_argv)
  if (pin === null) {
    await finalize(inp, run, "soft_failed", "claimed argv not pinned (allowlist/brief)", { claimed: claimedArgv }, "none")
    return { decision: "pass", outcome: "soft_failed" }
  }
  const ws = resolveWorkspace(wsRoot, cwd)
  if (!ws.ok) { await finalize(inp, run, "soft_failed", `workspace: ${ws.detail}`, {}, "none"); return { decision: "pass", outcome: "soft_failed" } }
  const exec = await executeReplay(pin, ws.absCwd, { timeoutMs: policy.replay.timeout_ms, maxBytes: 1200, envAllow: policy.replay.env_allow })
  if (!exec.ran || exec.timedOut) { await finalize(inp, run, "soft_failed", `replay ${exec.timedOut ? "timeout" : "infra"}`, { detail: exec.detail }, "none"); return { decision: "pass", outcome: "soft_failed" } }
  if (exec.exitCode === expectExit) {
    // spine flip only when allowlist-pinned (argv came from policy allowlist) AND idempotent
    if (isSpine && brief?.isa_path && brief.isc_id) {
      const fromAllowlist = policy.replay.allowed_argv.some((a) => a.argv.join("\0") === pin.argv.join("\0"))
      if (fromAllowlist) {
        const fileScope = hashScope(inp.project, [...(brief.files_in_scope ?? [])])
        const g: EvidenceGraph = {
          schema_version: 1, isc_id: brief.isc_id, isa_path: brief.isa_path, flipped_at: new Date().toISOString(),
          flip_source: "replay", user_pinned: true, trust_label: "verified",
          depends_on: { argv: pin.argv, argv_pin: "policy-allowlist", env_hash: sha256(policy.replay.env_allow.join(",")), cwd: pin.cwd, file_scope: fileScope, git_head: null },
          status: "valid", confirmation: null,
        }
        writeEvidence(inp.project, inp.session_id, g)
        await appendLedger(inp.project, "isc-flip", { isc: brief.isc_id, channel: "replay", user_pinned: true, trust_label: "verified", evidence_status: "valid" })
      }
    }
    await finalize(inp, run, "accepted_verified", `replay match: ${pin.argv.join(" ")} exit ${exec.exitCode}`, {}, "verified")
    return { decision: "pass", outcome: "accepted_verified" }
  }
  // contradiction
  if (run.blocks_used < 2) { run.blocks_used++; saveRun(inp.project, run); return { decision: "block", reason: `replay did not match: ${pin.argv.join(" ")} exit ${exec.exitCode} (expected ${expectExit}). Fix or revise.` } }
  await finalize(inp, run, "rejected", `replay contradiction: got ${exec.exitCode}`, { tail: exec.tail }, "none")
  return { decision: "pass", outcome: "rejected" }
}

async function finalize(inp: StopInput, run: RunState | null, outcome: Outcome, summary: string, evidence: Record<string, unknown>, trust: "verified" | "sampled" | "none"): Promise<void> {
  if (run) { run.state = "TERMINAL"; run.terminal_outcome = outcome; run.last_event_seq = inp.event_seq; saveRun(inp.project, run) }
  const role: Role = run?.agent_type ?? "implementer"
  const v = signVerdict(inp.project, {
    schema_version: 1, run_id: inp.run_id, agent_id: run?.agent_id ?? inp.run_id, role,
    outcome, trust_label: trust, summary_line: summary.slice(0, 200), evidence, advice: outcome === "accepted_verified" ? "verified" : "treat as advisory; verify before integrating",
  })
  saveVerdict(inp.project, inp.session_id, v)
  await appendLedger(inp.project, "worker-acceptance", { run_id: inp.run_id, role, outcome, trust_label: trust })
}
