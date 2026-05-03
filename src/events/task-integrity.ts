import { Effect } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"

export const handleTaskCreated = (
  payload: HookPayload,
): Effect.Effect<HookDecision> =>
  Effect.sync(() => {
    if (payload._tag !== "TaskCreated") return SAFE_DEFAULT
    // M4: advisory only — never blocks task creation.
    return SAFE_DEFAULT
  })

export const handleTaskCompleted = (
  payload: HookPayload,
): Effect.Effect<HookDecision> =>
  Effect.sync(() => {
    if (payload._tag !== "TaskCompleted") return SAFE_DEFAULT
    const ac = payload.acceptance_criteria
    const ev = payload.evidence
    const missingAc = typeof ac !== "string" || ac.trim().length === 0
    const missingEv = !Array.isArray(ev) || ev.length === 0
    if (!missingAc && !missingEv) return SAFE_DEFAULT
    const decision: HookDecision = {
      decision: "block",
      reason:
        "Task completion requires acceptance_criteria and evidence fields. Provide both before marking complete.",
    }
    return decision
  })
