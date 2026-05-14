import { Effect } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { NO_DECISION } from "../schema/decisions.ts"
import { Approvals } from "../services/approvals.ts"
import { Project } from "../services/project.ts"
import { derivePatternKey } from "../policies/permission-patterns.ts"
import { reportHookFailure } from "../services/hook-failure.ts"

/**
 * PermissionRequest autopilot.
 *
 * Output shape conforms to the official Claude Code hook spec:
 *
 *   { hookSpecificOutput: {
 *       hookEventName: "PermissionRequest",
 *       decision: { behavior: "allow" | "deny", message?: string, ... }
 *   } }
 *
 * - "allow"  emitted on a prior recorded approval for the pattern.
 * - "deny"   emitted on a prior recorded denial for the pattern (with reason
 *            in `message`).
 * - NO_DECISION (`{}`) emitted for unseen / pending patterns: this is what
 *            causes Claude Code to show its built-in permission dialog
 *            (the implicit "ask" — there is no explicit "ask" behavior in
 *            the official spec).
 */
export const handlePermissionRequest = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, Approvals | Project> =>
  Effect.gen(function* () {
    if (payload._tag !== "PermissionRequest") return NO_DECISION
    const approvals = yield* Approvals
    const project = yield* Project
    const cwd = payload.cwd ?? (yield* project.root())
    const pattern = derivePatternKey(payload.tool_name, payload.tool_input)

    const lookup = yield* approvals
      .lookup(cwd, pattern)
      .pipe(
        Effect.catchAll((cause) =>
          reportHookFailure({
            kind: "state_read_failed",
            event: "PermissionRequest",
            sessionId: payload.session_id,
            cause,
            fallbackDecision: NO_DECISION,
            hookSafe: true,
            context: {
              op: "approvals.lookup",
              cwd,
              tool_name: payload.tool_name,
              pattern,
            },
          }).pipe(Effect.as(null)),
        ),
      )

    // A "pending" record is not a resolved decision; treat it as no decision.
    const resolved =
      lookup !== null && (lookup.status === "approved" || lookup.status === "denied")
        ? lookup
        : null

    if (resolved === null) {
      // No prior decision — record a "pending" stub so downstream tooling can
      // resolve the same pattern key, and emit no decision to defer to
      // Claude Code's normal permission dialog.
      yield* approvals
        .record({ cwd, pattern, status: "pending", recordedAt: Date.now() })
        .pipe(
          Effect.catchAll((cause) =>
            reportHookFailure({
              kind: "state_write_failed",
              event: "PermissionRequest",
              sessionId: payload.session_id,
              cause,
              fallbackDecision: NO_DECISION,
              hookSafe: true,
              context: {
                op: "approvals.record",
                cwd,
                tool_name: payload.tool_name,
                pattern,
                status: "pending",
              },
            }),
          ),
        )
      return NO_DECISION
    }

    if (resolved.status === "approved") {
      const decision: HookDecision = {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      }
      return decision
    }

    // denied
    const decision: HookDecision = {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: `auto-denied by claude-hooks-ts (prior denial for pattern ${pattern})`,
        },
      },
    }
    return decision
  })
