import { Effect } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { Approvals } from "../services/approvals.ts"
import { Project } from "../services/project.ts"
import { derivePatternKey } from "../policies/permission-patterns.ts"

export const handlePermissionRequest = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, Approvals | Project> =>
  Effect.gen(function* () {
    if (payload._tag !== "PermissionRequest") return SAFE_DEFAULT
    const approvals = yield* Approvals
    const project = yield* Project
    const cwd = payload.cwd ?? (yield* project.root())
    const pattern = derivePatternKey(payload.tool_name, payload.tool_input)

    const lookup = yield* approvals
      .lookup(cwd, pattern)
      .pipe(Effect.catchAll(() => Effect.succeed(null)))

    // A "pending" record is not a resolved decision; treat it as no decision.
    const resolved =
      lookup !== null && (lookup.status === "approved" || lookup.status === "denied")
        ? lookup
        : null

    const decisionKind: "allow" | "deny" | "ask" =
      resolved === null ? "ask" : resolved.status === "approved" ? "allow" : "deny"

    const reason =
      decisionKind === "allow"
        ? `auto-approved by autopilot (prior approval for pattern ${pattern})`
        : decisionKind === "deny"
          ? `auto-denied by autopilot (prior denial for pattern ${pattern})`
          : `no prior decision for pattern ${pattern}; asking user`

    if (decisionKind === "ask") {
      // Record the ask as pending so downstream tooling (CLI / future
      // post-decision events) can resolve the same pattern key. This is what
      // makes the ledger actually populated rather than dead state.
      yield* approvals
        .record({ cwd, pattern, status: "pending", recordedAt: Date.now() })
        .pipe(Effect.catchAll(() => Effect.succeed(undefined as void)))
    }

    const decision: HookDecision = {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        permissionDecision: decisionKind,
        permissionDecisionReason: reason,
      },
    }
    return decision
  })
