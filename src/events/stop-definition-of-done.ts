import { Effect } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { SessionState } from "../services/session-state.ts"

const BLOCK_REASON =
  "Code changed but no verification command has run. Run the smallest relevant test/typecheck now, then summarize the result."

const RESEARCH_BLOCK_REASON =
  "Research answer is not ready: source ledger has unsupported claims. Reconcile claims to sources and state uncertainties before final response."

/**
 * Stop handler.
 *
 * Loop-protection note: the official Claude Code Stop event payload does NOT
 * carry a `stop_hook_active` field (despite earlier docs/community examples).
 * We instead rely on `SessionState.stop_blocked_once` — once a session has
 * blocked one Stop, the next Stop in that session is allowed through to
 * avoid an infinite block loop.
 */
export const handleStop = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, SessionState> =>
  Effect.gen(function* () {
    if (payload._tag !== "Stop") return SAFE_DEFAULT
    const state = yield* SessionState
    const record = yield* state
      .get(payload.session_id)
      .pipe(Effect.catchAll(() => Effect.succeed(null)))
    if (record === null) return SAFE_DEFAULT
    // Local loop-guard: never block twice in the same session.
    if (record.stop_blocked_once) return SAFE_DEFAULT

    // Research-mode source-ledger gate
    const lw = record.last_workflow
    if (
      typeof lw === "string" &&
      lw.startsWith("research.") &&
      record.source_urls.length === 0
    ) {
      yield* state
        .update(payload.session_id, { stop_blocked_once: true })
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      const out: HookDecision = {
        decision: "block",
        reason: RESEARCH_BLOCK_REASON,
      }
      return out
    }

    const filesChanged = record.files_changed.length
    if (filesChanged > 0 && record.verification_status !== "passed") {
      yield* state
        .update(payload.session_id, { stop_blocked_once: true })
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      const out: HookDecision = {
        decision: "block",
        reason: BLOCK_REASON,
      }
      return out
    }
    return SAFE_DEFAULT
  })
