import { describe, expect, test } from "bun:test"
import { route } from "../hook-entry.ts"
import { loadRun } from "../runs.ts"
import { gitProject, registerBrief, implResult } from "./helpers.ts"
import type { WorkerBrief } from "../types.ts"

/** Adapter-level tests: drive route() with synthetic host payloads (the real live path), exercising
 *  the host-fact correlation the dispatch functions can't see — agent_id/agent_type, verdict delivery. */
describe("adapter route() — host-fact correlation (F3/F4/F6)", () => {
  test("F3: a scout worker's Write is denied via host agent_type; orchestrator Write allowed", async () => {
    const p = gitProject()
    const sess = "s-f3"
    await route({ hook_event_name: "SessionStart", session_id: sess, cwd: p })
    // orchestrator (no agent_id) — full authority
    const orch = await route({ hook_event_name: "PreToolUse", session_id: sess, cwd: p, tool_name: "Write", tool_input: { file_path: "src/x.ts" } })
    expect(orch).toEqual({})
    // worker scout (host marks the call with agent_id + agent_type) — capability-gated
    const worker = await route({ hook_event_name: "PreToolUse", session_id: sess, cwd: p, agent_id: "w1", agent_type: "scout", tool_name: "Write", tool_input: { file_path: "src/x.ts" } }) as { hookSpecificOutput?: { permissionDecision?: string } }
    expect(worker.hookSpecificOutput?.permissionDecision).toBe("deny")
  })

  test("F6: pending briefs correlate by role even when SubagentStart arrives reversed", async () => {
    const p = gitProject()
    const sess = "s-f6"
    await route({ hook_event_name: "SessionStart", session_id: sess, cwd: p })
    registerBrief(p, { schema_version: 1, role: "implementer", label: "impl-leg", acceptance: { argv: ["true"], cwd: ".", replay: "required", idempotent: true } })
    registerBrief(p, { schema_version: 1, role: "scout", label: "scout-leg" } as WorkerBrief)
    // orchestrator spawns implementer THEN scout
    await route({ hook_event_name: "PreToolUse", session_id: sess, cwd: p, tool_name: "Agent", tool_input: { subagent_type: "implementer", label: "impl-leg" } })
    await route({ hook_event_name: "PreToolUse", session_id: sess, cwd: p, tool_name: "Agent", tool_input: { subagent_type: "scout", label: "scout-leg" } })
    // host delivers the SCOUT's SubagentStart FIRST (reversed vs spawn order) — blind FIFO would mis-bind
    await route({ hook_event_name: "SubagentStart", session_id: sess, cwd: p, agent_id: "agScout", agent_type: "scout" })
    await route({ hook_event_name: "SubagentStart", session_id: sess, cwd: p, agent_id: "agImpl", agent_type: "implementer" })
    expect((loadRun(p, sess, "agScout")?.brief_snapshot as { label?: string } | null)?.label).toBe("scout-leg")
    expect((loadRun(p, sess, "agImpl")?.brief_snapshot as { label?: string } | null)?.label).toBe("impl-leg")
  })

  test("F4: verdict delivered to orchestrator via PostToolUse(Agent); SubagentStop stays silent", async () => {
    const p = gitProject()
    const sess = "s-f4"
    await route({ hook_event_name: "SessionStart", session_id: sess, cwd: p })
    registerBrief(p, { schema_version: 1, role: "implementer", label: "impl-a", acceptance: { argv: ["true"], cwd: ".", replay: "required", idempotent: true } })
    await route({ hook_event_name: "PreToolUse", session_id: sess, cwd: p, tool_name: "Agent", tool_input: { subagent_type: "implementer", label: "impl-a" } })
    await route({ hook_event_name: "SubagentStart", session_id: sess, cwd: p, agent_id: "agA", agent_type: "implementer" })
    // SubagentStop must NOT emit output — any non-empty output resumes the stopped subagent (probe finding)
    const stop = await route({ hook_event_name: "SubagentStop", session_id: sess, cwd: p, agent_id: "agA", result_summary: implResult("impl-a", p, ["true"]) })
    expect(stop).toEqual({})
    // the orchestrator sees the signed verdict when its Agent tool call completes (tool_response.agentId correlates)
    const post = await route({ hook_event_name: "PostToolUse", session_id: sess, cwd: p, tool_name: "Agent", tool_response: { agentId: "agA", status: "completed" } }) as { hookSpecificOutput?: { additionalContext?: string } }
    const ctx = post.hookSpecificOutput?.additionalContext ?? ""
    expect(ctx).toContain("verified-by-hook")
    expect(ctx).toContain("accepted_verified")
  })
})
