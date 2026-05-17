import { Effect } from "effect"
import * as crypto from "node:crypto"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { NO_DECISION } from "../schema/decisions.ts"
import { Project } from "../services/project.ts"
import { Elicitations } from "../services/elicitations.ts"
import { reportHookFailure } from "../services/hook-failure.ts"

// ElicitationResult lacks the original `elicitation` request shape, so we
// approximate the signature from (server, tool, sorted top-level content keys).
const resultSignature = (serverName: string, toolName: string, content: unknown): string => {
  const keys = content !== null && typeof content === "object"
    ? Object.keys(content as Record<string, unknown>).sort().join(",")
    : ""
  return crypto.createHash("sha1").update(`${serverName}|${toolName}|${keys}`).digest("hex").slice(0, 16)
}

export const handleElicitationResult = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, Project | Elicitations> =>
  Effect.gen(function* () {
    if (payload._tag !== "ElicitationResult") return NO_DECISION
    const project = yield* Project
    const cwd = yield* project.root()
    const elicitations = yield* Elicitations
    const pending = yield* elicitations
      .findLatestPending(
        payload.session_id,
        cwd,
        payload.server_name,
        payload.tool_name,
      )
      .pipe(
        Effect.catchAll((cause) =>
          reportHookFailure({
            kind: "state_read_failed",
            event: "ElicitationResult",
            sessionId: payload.session_id,
            cause,
            hookSafe: true,
            context: {
              op: "elicitations.findLatestPending",
              cwd,
              server: payload.server_name,
              tool_name: payload.tool_name,
            },
          }).pipe(Effect.as(null)),
        ),
      )
    const signature =
      pending?.requestSignature ??
      resultSignature(payload.server_name, payload.tool_name, payload.content)
    yield* elicitations
      .record(cwd, payload.server_name, payload.tool_name, signature, payload.action, payload.content)
      .pipe(
        Effect.catchAll((cause) =>
          reportHookFailure({
            kind: "state_write_failed",
            event: "ElicitationResult",
            sessionId: payload.session_id,
            cause,
            hookSafe: true,
            context: {
              op: "elicitations.record",
              cwd,
              server: payload.server_name,
              tool_name: payload.tool_name,
              action: payload.action,
            },
          }),
        ),
      )
    return NO_DECISION
  })
