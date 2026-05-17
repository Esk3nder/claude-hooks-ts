import { Effect } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { NO_DECISION } from "../schema/decisions.ts"
import { Project } from "../services/project.ts"
import { PolicyConfig } from "../services/policy-config.ts"
import { Elicitations, elicitationSignature } from "../services/elicitations.ts"
import { containsRedactedPersistenceMarker } from "../services/event-store.ts"
import { reportHookFailure } from "../services/hook-failure.ts"

export const handleElicitation = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, Project | PolicyConfig | Elicitations> =>
  Effect.gen(function* () {
    if (payload._tag !== "Elicitation") return NO_DECISION
    const project = yield* Project
    const cwd = yield* project.root()
    const policy = yield* PolicyConfig
    const cfg = yield* policy.load()
    if (cfg.elicitationDenylist.includes(payload.server_name)) {
      return { hookSpecificOutput: { hookEventName: "Elicitation" as const, action: "decline" as const } }
    }
    const signature = elicitationSignature(payload.elicitation)
    const elicitations = yield* Elicitations
    yield* elicitations
      .recordPending(
        payload.session_id,
        cwd,
        payload.server_name,
        payload.tool_name,
        signature,
      )
      .pipe(
        Effect.catchAll((cause) =>
          reportHookFailure({
            kind: "state_write_failed",
            event: "Elicitation",
            sessionId: payload.session_id,
            cause,
            hookSafe: true,
            context: {
              op: "elicitations.recordPending",
              cwd,
              server: payload.server_name,
              tool_name: payload.tool_name,
            },
          }),
        ),
      )
    const stored = yield* elicitations
      .lookup(cwd, payload.server_name, payload.tool_name, signature)
      .pipe(
        Effect.catchAll((cause) =>
          reportHookFailure({
            kind: "state_read_failed",
            event: "Elicitation",
            sessionId: payload.session_id,
            cause,
            hookSafe: true,
            context: {
              op: "elicitations.lookup",
              cwd,
              server: payload.server_name,
              tool_name: payload.tool_name,
            },
          }).pipe(Effect.as(null)),
        ),
      )
    if (stored === null) return NO_DECISION
    if (stored.action === "accept") {
      if (containsRedactedPersistenceMarker(stored.content)) return NO_DECISION
      return { hookSpecificOutput: { hookEventName: "Elicitation" as const, action: "accept" as const, content: stored.content } }
    }
    if (stored.action === "decline") {
      return { hookSpecificOutput: { hookEventName: "Elicitation" as const, action: "decline" as const } }
    }
    return NO_DECISION
  })
