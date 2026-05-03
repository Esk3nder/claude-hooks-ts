import { Effect } from "effect"
import * as crypto from "node:crypto"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { Project } from "../services/project.ts"
import { Elicitations } from "../services/elicitations.ts"

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
    if (payload._tag !== "ElicitationResult") return SAFE_DEFAULT
    const project = yield* Project
    const cwd = yield* project.root()
    const elicitations = yield* Elicitations
    const signature = resultSignature(payload.server_name, payload.tool_name, payload.content)
    yield* elicitations
      .record(cwd, payload.server_name, payload.tool_name, signature, payload.action, payload.content)
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
    return SAFE_DEFAULT
  })
