import { Effect } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { classifyPrompt } from "../policies/workflow-classifier.ts"
import { SessionState } from "../services/session-state.ts"

export const handleUserPromptSubmit = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, SessionState> =>
  Effect.gen(function* () {
    if (payload._tag !== "UserPromptSubmit") return SAFE_DEFAULT
    const { workflow, playbook } = classifyPrompt(payload.prompt)
    const state = yield* SessionState
    yield* state
      .update(payload.session_id, { last_workflow: workflow })
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
    const additionalContext = `Detected workflow: ${workflow}. ${playbook}`
    const out: HookDecision = {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
    }
    return out
  })
