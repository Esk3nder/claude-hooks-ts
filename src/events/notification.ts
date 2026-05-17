import { Effect } from "effect"
import * as path from "node:path"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { NO_DECISION } from "../schema/decisions.ts"
import { eventStream, NotificationRecordSchema } from "../schema/events.ts"
import { EventStore, summarizeEventStoreError } from "../services/event-store.ts"
import { Project } from "../services/project.ts"
import { logWarning } from "../services/diagnostics.ts"

interface NotificationLedgerEntry {
  readonly session_id: string
  readonly notification_type: string
  readonly message: string
  readonly ts: string
}

/**
 * Notification — appends a ledger entry under <cwd>/.claude-hooks/state/notifications.jsonl
 * for future correlation (e.g. idle/waiting nudges). Always returns NO_DECISION.
 * EventStore owns locking, schema decode, redaction, and line caps.
 */
export const handleNotification = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, EventStore | Project> =>
  Effect.gen(function* () {
    if (payload._tag !== "Notification") return NO_DECISION
    const eventStore = yield* EventStore
    const project = yield* Project
    const root = yield* project.root()
    const ledgerPath = path.join(
      root,
      ".claude-hooks",
      "state",
      "notifications.jsonl",
    )
    const entry: NotificationLedgerEntry = {
      session_id: payload.session_id,
      notification_type: payload.notification_type,
      message: payload.message,
      ts: new Date().toISOString(),
    }
    yield* eventStore
      .append(eventStream("notifications", ledgerPath, NotificationRecordSchema, { maxRecords: 1_000 }), entry)
      .pipe(
        Effect.catchAll((err) =>
          logWarning(`notification: ledger write failed: ${summarizeEventStoreError(err)}`),
        ),
      )
    return NO_DECISION
  })
