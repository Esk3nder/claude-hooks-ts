/**
 * v2 hook adapter — the binary Claude Code actually calls.
 * Reads one hook event on stdin, routes to the v2 decision functions, writes one decision on stdout.
 * Field names are the real host facts confirmed by the conformance probes (agent_id, agent_type,
 * last_assistant_message, tool_name, tool_input, session_id). Standalone (not the Effect dispatcher);
 * full Effect merge is later migration work.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { createHmac } from "node:crypto"
import { stateRoot, hookLog, writeHookOnly } from "./fsx.ts"
import { handleSessionStart, handleSubagentStart, handlePreToolUse, handleStop } from "./dispatch.ts"
import { handleSubagentStop } from "./seam.ts"
import { sessionSecret, loadVerdict, verifyVerdict, type RunState, type Verdict } from "./runs.ts"
import type { GateDecision } from "./gates.ts"
import type { Role } from "./types.ts"

type Payload = Record<string, unknown>
const str = (p: Payload, k: string): string => (typeof p[k] === "string" ? (p[k] as string) : "")

function projectRoot(cwd: string): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" })
  return r.status === 0 ? r.stdout.trim() : cwd
}

// --- pragmatic spawn correlation: PreToolUse(Agent) records {label,role,parent}; SubagentStart pops it (FIFO) ---
interface Pending { label: string; role: Role; parent_run_id: string | null }
function pendingPath(project: string, session: string): string {
  return join(stateRoot(project), "runs", "pending", `${session}.json`)
}
function pushPending(project: string, session: string, p: Pending): void {
  const path = pendingPath(project, session)
  mkdirSync(join(stateRoot(project), "runs", "pending"), { recursive: true })
  const q: Pending[] = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : []
  q.push(p)
  writeFileSync(path, JSON.stringify(q), { mode: 0o600 })
}
/** Pop the first pending brief whose role matches the starting subagent (host fact: SubagentStart
 *  carries agent_type). No role match ⇒ null: the run gets no brief snapshot and stays untrusted —
 *  fail closed under concurrent/reordered spawns rather than bind a mismatched brief (F6, SPEC §6.5). */
function popPendingByRole(project: string, session: string, role: Role): Pending | null {
  const path = pendingPath(project, session)
  if (!existsSync(path)) return null
  const q: Pending[] = JSON.parse(readFileSync(path, "utf8"))
  const idx = q.findIndex((p) => p.role === role)
  if (idx === -1) return null
  const [head] = q.splice(idx, 1)
  writeFileSync(path, JSON.stringify(q), { mode: 0o600 })
  return head ?? null
}

/** Concise, hook-authored verdict line for orchestrator injection (F4) — the worker cannot forge it. */
function formatVerdict(v: Verdict): string {
  return `[verified-by-hook] worker ${v.role} ${v.run_id}: outcome=${v.outcome} trust=${v.trust_label} — ${v.summary_line} (advice: ${v.advice})`
}

function findRunIdByAgent(project: string, session: string, agentId: string): string | null {
  const dir = join(stateRoot(project), "runs", "state", session)
  if (!existsSync(dir)) return null
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue
    try { const s = JSON.parse(readFileSync(join(dir, f), "utf8")) as RunState; if (s.agent_id === agentId) return s.run_id } catch { /* skip */ }
  }
  return null
}

function gateToDecision(d: GateDecision): object {
  if (d.kind === "allow") return {}
  if (d.kind === "ask") return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: d.reason } }
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason } }
}

/** Capture a host-delivered user confirmation (BUILD-SPEC §11). Only the host can produce this;
 *  workers cannot forge it. Stored HMAC-signed for the evidential gate to consume. */
function captureConfirmation(project: string, session: string, payload: Payload): void {
  const isc = str(payload, "isc_id") || str(payload, "elicitation_id")
  const accepted = payload["accepted"] === true || str(payload, "response").toLowerCase().startsWith("y")
  if (!isc || !accepted) return
  const body = { schema_version: 1, isc_id: isc, session, confirmed_at: new Date().toISOString(), source: "host_elicitation" }
  const sig = createHmac("sha256", sessionSecret(project)).update(JSON.stringify(body)).digest("hex")
  try {
    writeHookOnly(join(stateRoot(project), "confirmations", session, `${isc.replace(/[^\w-]/g, "_")}.json`), JSON.stringify({ ...body, sig }, null, 2))
  } catch { /* availability: never trap */ }
}

/** Active-ISA ISCs that have an evidence file — passed to Stop so staleness blocks completion. */
function evidenceIscs(project: string, session: string): { isc: string; required: boolean }[] {
  const dir = join(stateRoot(project), "evidence", session)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => ({ isc: f.replace(/\.json$/, ""), required: true }))
}

/** Events v2 is wired on but has no active logic for yet — it stays AWARE (logs) and no-ops. */
const NOOP_AWARE = new Set([
  "PostToolUse", "PostToolUseFailure", "PostToolBatch", "PreCompact", "PostCompact",
  "SessionEnd", "PermissionRequest", "PermissionDenied", "ConfigChange", "FileChanged",
  "Notification", "Setup", "InstructionsLoaded", "CwdChanged", "StopFailure",
  "UserPromptSubmit", "UserPromptExpansion", "TaskCreated", "TaskCompleted",
  "WorktreeCreate", "WorktreeRemove",
])

export async function route(payload: Payload): Promise<object> {
  const event = str(payload, "hook_event_name")
  const cwd = str(payload, "cwd") || process.cwd()
  const project = projectRoot(cwd)
  const session = str(payload, "session_id") || "default"

  // Awareness: every event v2 sees is recorded, even ones it no-ops on (user ask: "the system should be aware").
  hookLog(project, `event ${event} session=${session}`)

  switch (event) {
    case "SessionStart": {
      handleSessionStart(project, session)
      return {}
    }
    case "PreToolUse": {
      const tool = str(payload, "tool_name")
      const input = (payload["tool_input"] as Payload) ?? {}
      const base = tool.split("(")[0]!
      // host fact: agent_id/agent_type appear ONLY when this call originates inside a subagent.
      const callerAgentId = str(payload, "agent_id")
      const callerRole = (str(payload, "agent_type") as Role) || undefined
      const callerRunId = callerAgentId ? (findRunIdByAgent(project, session, callerAgentId) ?? callerAgentId) : null
      if (base === "Agent" || base === "Task") {
        const role = (input["subagent_type"] ?? input["agent_type"]) as Role | undefined
        const label = (input["label"] as string) ?? "child"
        if (role) pushPending(project, session, { label, role, parent_run_id: callerRunId })
      }
      return gateToDecision(handlePreToolUse({ project, session_id: session, run_id: callerRunId, tool_name: tool, tool_input: input, agent_type: callerAgentId ? callerRole : undefined }))
    }
    case "SubagentStart": {
      const agentId = str(payload, "agent_id")
      const role = (str(payload, "agent_type") as Role) || "implementer"
      const pend = popPendingByRole(project, session, role) // F6: correlate by role, fail closed on no match
      const label = pend?.label ?? agentId
      const parent = pend?.parent_run_id ?? null
      const runId = parent ? `${parent}/${agentId}` : agentId
      handleSubagentStart({ project, session_id: session, run_id: runId, agent_id: agentId, parent_run_id: parent, agent_type: role, label })
      return {}
    }
    case "SubagentStop": {
      const agentId = str(payload, "agent_id")
      const runId = findRunIdByAgent(project, session, agentId) ?? agentId
      const msg = str(payload, "last_assistant_message") || str(payload, "result_summary")
      const r = await handleSubagentStop({ project, session_id: session, run_id: runId, event_seq: 1, last_assistant_message: msg })
      if (r.decision === "block") return { decision: "block", reason: r.reason }
      // F4: inject the hook-signed verdict so the orchestrator sees an unforgeable outcome, not just
      // the worker's self-authored message. SubagentStop carries the stable agent_id + supports additionalContext.
      const v = loadVerdict(project, session, runId)
      if (v && verifyVerdict(project, v)) return { hookSpecificOutput: { hookEventName: "SubagentStop", additionalContext: formatVerdict(v) } }
      return {}
    }
    case "Stop": {
      // kill-switch: stand the evidential Stop gate down per-environment (default: active)
      if (process.env["CLAUDE_HOOKS_DISABLE_EVIDENTIAL_GATE"] === "1") return {}
      const r = handleStop(project, session, evidenceIscs(project, session))
      return r.decision === "block" ? { decision: "block", reason: r.reason } : {}
    }
    case "ElicitationResult": {
      // Manual-confirmation channel (BUILD-SPEC §11): a host-delivered user response is the only
      // thing that can confirm a manual ISC flip. Capture it signed for later evidential use.
      captureConfirmation(project, session, payload)
      return {}
    }
    default:
      // Wired for awareness; no active gate. Flag genuinely-unknown events distinctly.
      if (!NOOP_AWARE.has(event)) hookLog(project, `UNKNOWN event ${event} (not in v2's known set)`)
      return {}
  }
}

if (import.meta.main) {
  const text = await new Response(Bun.stdin.stream()).text()
  let decision: object = {}
  try {
    decision = await route(JSON.parse(text) as Payload)
  } catch {
    decision = {} // fail open (availability); never trap the session
  }
  process.stdout.write(JSON.stringify(decision))
  process.exit(0)
}
