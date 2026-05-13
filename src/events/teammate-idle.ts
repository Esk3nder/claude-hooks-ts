import { Effect } from "effect"
import * as path from "node:path"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { eventStream, TeammateIdleRecordSchema } from "../schema/events.ts"
import { EventStore, summarizeEventStoreError } from "../services/event-store.ts"
import { Project } from "../services/project.ts"
import { SessionState } from "../services/session-state.ts"

interface TeammateIdleLedgerEntry {
  readonly session_id: string
  readonly teammate_name: string
  readonly teammate_type: string
  readonly ts: string
}

/**
 * TeammateIdle — block going idle if the session has unverified pending work
 * (`files_changed.length > 0 && verification_status !== "passed"`). Always
 * appends a best-effort ledger entry; ledger failures are swallowed so they
 * never affect the decision.
 */
export const handleTeammateIdle = (
  payload: HookPayload,
): Effect.Effect<
  HookDecision,
  never,
  EventStore | Project | SessionState
> =>
  Effect.gen(function* () {
    if (payload._tag !== "TeammateIdle") return SAFE_DEFAULT
    const eventStore = yield* EventStore
    const project = yield* Project
    const state = yield* SessionState
    const root = yield* project.root()

    const ledgerPath = path.join(
      root,
      ".claude-hooks",
      "state",
      "teammate-idle.jsonl",
    )
    const entry: TeammateIdleLedgerEntry = {
      session_id: payload.session_id,
      teammate_name: payload.teammate_name,
      teammate_type: payload.teammate_type,
      ts: new Date().toISOString(),
    }
    yield* eventStore
      .append(eventStream("teammate-idle", ledgerPath, TeammateIdleRecordSchema, { maxRecords: 1_000 }), entry)
      .pipe(
        Effect.tapError((cause) =>
          Effect.sync(() => {
            process.stderr.write(
              `[TeammateIdle] ledger append failed: ${summarizeEventStoreError(cause)}\n`,
            )
          }),
        ),
        Effect.catchAll(() => Effect.succeed(undefined)),
      )

    const stateE = yield* Effect.either(
      state.get(payload.session_id).pipe(
        Effect.tapError((cause) =>
          Effect.sync(() => {
            process.stderr.write(
              `[TeammateIdle] session-state op=get failed: sid=${payload.session_id} cause=${String(cause).slice(0, 160)}\n`,
            )
          }),
        ),
      ),
    )
    if (stateE._tag === "Right") {
      const rec = stateE.right
      if (
        rec.files_changed.length > 0 &&
        rec.verification_status !== "passed"
      ) {
        return {
          decision: "block",
          reason: `Files changed (${rec.files_changed.length}) without verification — finish current work before going idle.`,
        }
      }
    }
    return SAFE_DEFAULT
  })
