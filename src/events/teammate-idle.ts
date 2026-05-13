import { Effect, Option } from "effect"
import * as path from "node:path"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { NO_DECISION } from "../schema/decisions.ts"
import { eventStream, TeammateIdleRecordSchema } from "../schema/events.ts"
import { EventStore, summarizeEventStoreError } from "../services/event-store.ts"
import { Project } from "../services/project.ts"
import { SessionState } from "../services/session-state.ts"
import { logWarning } from "../services/diagnostics.ts"
import { loadRuntimeConfig } from "../services/runtime-config.ts"
import { WorkerAggregation } from "../services/worker-aggregation.ts"
import type { WorkerIntegrationSummary } from "../schema/worker-run.ts"

interface TeammateIdleLedgerEntry {
  readonly session_id: string
  readonly teammate_name: string
  readonly teammate_type: string
  readonly ts: string
}

/**
 * TeammateIdle — block going idle if the session has unverified pending work
 * or unresolved worker integration. Always appends a best-effort ledger entry;
 * ledger failures are swallowed so they never affect the decision.
 */
const workerIdleBlockReason = (
  summary: WorkerIntegrationSummary,
  finalVerificationCurrent: boolean,
): string | null => {
  if (summary.workers_total === 0) return null
  if (summary.queued > 0 || summary.running > 0 || summary.blocked > 0) {
    return [
      "Worker runs are still unresolved; finish, block, or cancel them before going idle.",
      `queued=${summary.queued}`,
      `running=${summary.running}`,
      `blocked=${summary.blocked}`,
    ].join(" ")
  }
  if (summary.failed > 0) {
    return `Worker runs failed (${summary.failed}); resolve or cancel failed workers before going idle.`
  }
  if (summary.conflicts.length > 0) {
    return `Worker outputs have integration conflicts: ${summary.conflicts.map((conflict) => conflict.path).join(", ")}.`
  }
  if (summary.blockers.length > 0) {
    return `Worker outputs still report blockers: ${summary.blockers.slice(0, 3).join("; ")}`
  }
  if (summary.final_verification_required && !finalVerificationCurrent) {
    return "Integrated worker changes still need final parent-workspace verification before going idle."
  }
  return null
}

const workerIdleStateReadFailure = (sessionId: string): string =>
  `Worker state could not be read (session=${sessionId}); retry after the worker ledger is readable.`

const verificationCoversWorkerIntegration = (
  summary: WorkerIntegrationSummary,
  verificationStatus: string | undefined,
  verificationAt: string | null | undefined,
): boolean => {
  if (!summary.final_verification_required) return true
  if (verificationStatus !== "passed") return false
  if (summary.latest_integrated_at === undefined) return true
  if (verificationAt === undefined || verificationAt === null) return false
  const verified = Date.parse(verificationAt)
  const integrated = Date.parse(summary.latest_integrated_at)
  return Number.isFinite(verified) && Number.isFinite(integrated) && verified >= integrated
}

const evaluateWorkerIdle = (
  sessionId: string,
  verificationStatus: string | undefined,
  verificationAt: string | null | undefined,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const config = yield* loadRuntimeConfig
    if (!config.workersEnabled) return null
    const aggregation = yield* Effect.serviceOption(WorkerAggregation)
    if (Option.isNone(aggregation)) return null
    const lookup = yield* aggregation.value.summarizeSession(sessionId).pipe(Effect.either)
    if (lookup._tag === "Left") {
      return yield* logWarning(
        `[TeammateIdle] worker aggregation failed: sid=${sessionId} cause=${String(lookup.left).slice(0, 160)}`,
      ).pipe(Effect.as(workerIdleStateReadFailure(sessionId)))
    }
    const summary = lookup.right
    return workerIdleBlockReason(
      summary,
      verificationCoversWorkerIntegration(summary, verificationStatus, verificationAt),
    )
  })

export const handleTeammateIdle = (
  payload: HookPayload,
): Effect.Effect<
  HookDecision,
  never,
  EventStore | Project | SessionState
> =>
  Effect.gen(function* () {
    if (payload._tag !== "TeammateIdle") return NO_DECISION
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
          logWarning(`[TeammateIdle] ledger append failed: ${summarizeEventStoreError(cause)}`),
        ),
        Effect.catchAll(() => Effect.succeed(undefined)),
      )

    const stateE = yield* Effect.either(
      state.get(payload.session_id).pipe(
        Effect.tapError((cause) =>
          logWarning(
            `[TeammateIdle] session-state op=get failed: sid=${payload.session_id} cause=${String(cause).slice(0, 160)}`,
          ),
        ),
      ),
    )
    if (stateE._tag === "Left") {
      return {
        decision: "block",
        reason: `Session state could not be read (session=${payload.session_id}); retry after state is readable before going idle.`,
      }
    }
    if (stateE._tag === "Right") {
      const rec = stateE.right
      const workerBlockReason = yield* evaluateWorkerIdle(
        payload.session_id,
        rec.verification_status,
        rec.verification_at,
      )
      if (workerBlockReason !== null) {
        return {
          decision: "block",
          reason: workerBlockReason,
        }
      }
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
    return NO_DECISION
  })
