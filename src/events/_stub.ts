import { Effect } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"

/**
 * M1 stub handler — every event routes here and emits a NoOp decision.
 * Real handlers land in M2/M3/M4.
 */
export const handleStub = (
  _action: string,
  _payload: HookPayload,
): Effect.Effect<HookDecision> => Effect.succeed(SAFE_DEFAULT)
