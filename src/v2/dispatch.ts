/** Event dispatch for the build (BUILD-SPEC §12): SessionStart, PreToolUse, SubagentStart, SubagentStop, Stop.
 * Host-only spawning/elicitation are simulated by the e2e driver; everything deterministic is real. */
import { loadBrief } from "./briefs.ts"
import { loadRun, saveRun, concurrentRuns, verifyConfirmation, type RunState } from "./runs.ts"
import { loadPolicy, POLICY_REL } from "./config.ts"
import { deriveAuthority, canSpawn, type NodeAuthority } from "./recursion.ts"
import { ROLE_CAPS, coerceRole, type Role } from "./types.ts"
import { evalBashSafety, evalPathSafety, evalCapability, type GateDecision } from "./gates.ts"
import { writeBaseline } from "./trust.ts"
import { revalidate, loadEvidence } from "./evidence.ts"
import { findActiveIsa } from "./isa.ts"
export { handleSubagentStop } from "./seam.ts"

export function handleSessionStart(project: string, sessionId: string): void {
  writeBaseline(project, sessionId, [POLICY_REL, "probes.ts"])
}

export interface StartInput {
  project: string
  session_id: string
  run_id: string
  agent_id: string
  parent_run_id: string | null
  agent_type: string // the HOST agent_type (e.g. general-purpose, Explore) — NOT assumed to be a v2 role
  label: string
}

/** Snapshot brief content + derive authority + ancestry. Returns the created RunState or an error. */
export function handleSubagentStart(inp: StartInput): { ok: true; run: RunState } | { ok: false; reason: string } {
  const lk = loadBrief(inp.project, inp.label)
  // snapshot is taken from the live brief AT START (before the worker runs). null if absent/invalid.
  const snapshot = lk.brief ? (JSON.parse(JSON.stringify(lk.brief)) as Record<string, unknown>) : null
  let parent: RunState | null = null
  let depth = 0
  let ancestry: string[] = []
  let parentAuthority: NodeAuthority | null = null
  if (inp.parent_run_id) {
    parent = loadRun(inp.project, inp.session_id, inp.parent_run_id)
    if (parent) { depth = parent.depth + 1; ancestry = [...parent.ancestry_labels]; parentAuthority = parent.authority }
  }
  // the v2 role is the BRIEF's assignment (authoritative); the host agent_type is only a fallback, and
  // only when it maps to a recognized restrictive role. Capability binds iff such an explicit role exists —
  // a general subagent (no brief, unrecognized host type) is uncapped, never throws (N1).
  const briefRole = lk.brief?.role
  const hostRole = coerceRole(inp.agent_type)
  const role: Role = briefRole ?? hostRole ?? "scout"
  const capped = briefRole !== undefined || hostRole !== null
  const authority = deriveAuthority(role, parentAuthority)
  const run: RunState = {
    schema_version: 1, session_id: inp.session_id, run_id: inp.run_id, agent_id: inp.agent_id,
    parent_run_id: inp.parent_run_id, agent_type: role, depth, ancestry_labels: [...ancestry, inp.label],
    authority, capped, state: "RUNNING", brief_snapshot: snapshot, warm: lk.brief?.warm === true,
    blocks_used: 0, terminal_outcome: null, last_event_seq: 0, panel_id: null,
  }
  saveRun(inp.project, run)
  return { ok: true, run }
}

export interface PreToolInput {
  project: string
  session_id: string
  run_id: string | null // null = orchestrator (depth 0); else the calling worker's run
  tool_name: string
  tool_input: Record<string, unknown>
}

/** PreToolUse: safety → capability → spawn-authority/caps. Security-class denials; malformed → ask. */
export function handlePreToolUse(inp: PreToolInput): GateDecision {
  const base = inp.tool_name.split("(")[0]!
  // safety (always, even for orchestrator)
  if (base === "Bash") {
    const cmd = inp.tool_input["command"]
    if (typeof cmd !== "string") return { kind: "ask", reason: "malformed Bash input" }
    const s = evalBashSafety(cmd); if (s.kind !== "allow") return s
  }
  if (base === "Edit" || base === "Write") {
    const path = inp.tool_input["file_path"] ?? inp.tool_input["path"]
    if (typeof path !== "string") return { kind: "ask", reason: "malformed write input" }
    const s = evalPathSafety(path); if (s.kind !== "allow") return s
  }
  // capability binds ONLY a run with an explicit restrictive role (capped) — a briefed v2 worker, or a
  // recognized restrictive host type. General subagents and the orchestrator are governed by the safety
  // plane only. Never derive authority from an unvalidated host agent_type (that threw → fail-open: N1).
  const run = inp.run_id ? loadRun(inp.project, inp.session_id, inp.run_id) : null
  if (run && run.capped) {
    const cap = evalCapability(inp.tool_name, run.authority.tools); if (cap.kind !== "allow") return cap
  }
  // spawn authority + caps (Agent/Task)
  if (base === "Agent" || base === "Task") {
    const childRole = (inp.tool_input["subagent_type"] ?? inp.tool_input["agent_type"]) as Role | undefined
    const childLabel = (inp.tool_input["label"] as string) ?? "child"
    if (childRole && ROLE_CAPS[childRole]) {
      const policy = loadPolicy(inp.project)
      const parentAuthority: NodeAuthority = run?.authority ?? { tools: [...ROLE_CAPS.implementer], may_spawn: true }
      const d = canSpawn({
        parentAuthority, parentDepth: run?.depth ?? 0, childRole, childTools: [...ROLE_CAPS[childRole]],
        ancestryLabels: run?.ancestry_labels ?? [], childLabel,
        childrenOfParent: 0, concurrentInSession: concurrentRuns(inp.project, inp.session_id),
        sessionTokensSpent: 0, sessionWallclockMs: 0, policy,
      })
      if (!d.allow) return { kind: "deny", reason: d.reason, cls: "security" }
    }
  }
  return { kind: "allow" }
}

/**
 * A declared ISC is satisfied only by a NON-AUTHOR evidence channel (SPEC §6.4, BUILD §3.2):
 * a currently-valid graph from a replay-verified flip, or a manual flip with a host confirmation
 * (§11). `sampled` never satisfies (it didn't replay this run); stale/absent never satisfies.
 */
function iscSatisfied(project: string, session: string, isc: string): boolean {
  if (revalidate(project, session, isc) !== "valid") return false
  const g = loadEvidence(project, session, isc)
  if (g === null || g.trust_label === "sampled") return false
  if (g.flip_source === "manual") return verifyConfirmation(project, session, isc) // §11: host-signed, unforgeable
  return true // replay-verified, graph still valid
}

/**
 * Stop: (a) revalidate any existing evidence for staleness (§4, every Stop), and
 * (b) when an ISA exists and reaches `phase: complete`, enforce the evidential gate (§6.4):
 * zero declared `## Criteria` blocks (empty-stub bypass), and any declared ISC without valid
 * non-author evidence blocks. No ISA ⇒ the completion gate does not bind.
 */
export function handleStop(project: string, session: string, iscs: { isc: string; required: boolean }[]): { decision: "block" | "pass"; reason?: string } {
  const stale: string[] = []
  const missing: string[] = []
  for (const { isc, required } of iscs) {
    const st = revalidate(project, session, isc)
    if (st === "stale") stale.push(isc)
    if (st === "absent" && required) missing.push(isc)
  }
  const isa = findActiveIsa(project, session)
  if (isa && isa.phase === "complete") {
    if (isa.iscs.length === 0) {
      return { decision: "block", reason: "evidential gate: ISA at phase: complete declares zero ## Criteria — declare verifiable criteria, or the completion is unsubstantiated" }
    }
    for (const isc of isa.iscs) if (!iscSatisfied(project, session, isc)) missing.push(isc)
  }
  if (stale.length || missing.length) {
    const uniq = [...new Set(missing)]
    return { decision: "block", reason: `evidential gate: stale=[${stale.join(",")}] unverified=[${uniq.join(",")}]` }
  }
  return { decision: "pass" }
}
