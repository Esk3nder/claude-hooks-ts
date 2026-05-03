import { Effect } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { SessionState, EMPTY_SESSION_STATE } from "../services/session-state.ts"
import { lookupRole, hasEvidence } from "../policies/subagent-roles.ts"

const invocationKey = (
  sessionId: string,
  taskId: string | undefined,
  index: number,
): string => `${sessionId}:${taskId ?? `idx${index}`}`

export const handleSubagentStart = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, SessionState> =>
  Effect.gen(function* () {
    if (payload._tag !== "SubagentStart") return SAFE_DEFAULT
    const state = yield* SessionState
    const prev = yield* state
      .get(payload.session_id)
      .pipe(Effect.catchAll(() => Effect.succeed(EMPTY_SESSION_STATE)))
    const key = invocationKey(
      payload.session_id,
      payload.task_id,
      prev.subagent_starts.length,
    )
    yield* state
      .append(payload.session_id, "subagent_starts", key)
      .pipe(Effect.catchAll(() => Effect.succeed(undefined as void)))

    const role = lookupRole(payload.subagent_type)
    const subagentLabel = payload.subagent_type ?? "subagent"
    const additionalContext = `Subagent ${subagentLabel} (${role.mode}): ${role.scopeRule}`
    const decision: HookDecision = {
      hookSpecificOutput: {
        hookEventName: "SubagentStart",
        additionalContext,
      },
    }
    return decision
  })

export const handleSubagentStop = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, SessionState> =>
  Effect.gen(function* () {
    if (payload._tag !== "SubagentStop") return SAFE_DEFAULT
    const state = yield* SessionState
    const prev = yield* state
      .get(payload.session_id)
      .pipe(Effect.catchAll(() => Effect.succeed(EMPTY_SESSION_STATE)))
    const key = invocationKey(
      payload.session_id,
      payload.task_id,
      prev.subagent_stops.length,
    )

    const alreadyBlocked = prev.subagent_stops.includes(`${key}:blocked`)

    yield* state
      .append(payload.session_id, "subagent_stops", key)
      .pipe(Effect.catchAll(() => Effect.succeed(undefined as void)))

    const role = lookupRole(payload.subagent_type)
    if (!role.investigative) return SAFE_DEFAULT
    if (alreadyBlocked) return SAFE_DEFAULT
    if (hasEvidence(payload.result)) return SAFE_DEFAULT

    yield* state
      .append(payload.session_id, "subagent_stops", `${key}:blocked`)
      .pipe(Effect.catchAll(() => Effect.succeed(undefined as void)))

    const decision: HookDecision = {
      decision: "block",
      reason:
        "Subagent output lacks evidence. Continue and return findings with file paths, commands run, and confidence.",
    }
    return decision
  })
