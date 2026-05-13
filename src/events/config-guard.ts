import { Effect } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { NO_DECISION } from "../schema/decisions.ts"

/**
 * ConfigChange handler — surfaces a context-injection note when the agent's
 * own configuration (settings, hooks, agents, permissions) is modified.
 * Real persistence/alerting lives in M3+; for M2 we emit additionalContext
 * so the user/agent has visibility.
 */
export const handleConfigChange = (
  payload: HookPayload,
): Effect.Effect<HookDecision> =>
  Effect.sync(() => {
    if (payload._tag !== "ConfigChange") return NO_DECISION
    const scope = payload.scope ?? "unknown"
    const note = `[config-guard] Configuration changed (scope=${scope}). Review the change for unintended permission/hook modifications.`
    const out: HookDecision = {
      hookSpecificOutput: {
        hookEventName: "ConfigChange",
        additionalContext: note,
      },
    }
    return out
  })
