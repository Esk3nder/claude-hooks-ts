import { Context, Effect, Layer } from "effect"
import * as path from "node:path"
import { EventStoreError } from "../schema/errors.ts"
import type {
  WorkerConflict,
  WorkerIntegrationSummary,
  WorkerRun,
} from "../schema/worker-run.ts"
import { WorkerRuns } from "./worker-runs.ts"

export interface WorkerAggregationApi {
  readonly summarizeSession: (
    sessionId: string,
  ) => Effect.Effect<WorkerIntegrationSummary, EventStoreError>
  readonly summarizeParent: (
    parentTaskId: string,
  ) => Effect.Effect<WorkerIntegrationSummary, EventStoreError>
}

export class WorkerAggregation extends Context.Tag("WorkerAggregation")<
  WorkerAggregation,
  WorkerAggregationApi
>() {}

const countStatus = (
  runs: ReadonlyArray<WorkerRun>,
  status: WorkerRun["status"],
): number => runs.filter((run) => run.status === status).length

const ACTIVE_RUN_STATUSES: ReadonlySet<WorkerRun["status"]> = new Set([
  "queued",
  "running",
  "blocked",
])

/**
 * P0-1: pretool worker-mandatory gate previously derived "is a worker
 * active?" from the `subagent_starts.length - subagent_stops.length`
 * delta on session state. If a SubagentStop append silently failed
 * (the catch in `subagent-scope-gate.ts` only reports), the delta stayed
 * permanently positive and the gate returned `allow` for every direct
 * write at tier ≥ E4. This helper exposes the runs ledger as the
 * authoritative source — a run is "active" iff its latest status is
 * queued/running/blocked.
 */
export const countActiveRuns = (runs: ReadonlyArray<WorkerRun>): number =>
  runs.reduce(
    (acc, run) => (ACTIVE_RUN_STATUSES.has(run.status) ? acc + 1 : acc),
    0,
  )

const workerResult = (run: WorkerRun) => run.result ?? run.output

const normalizeChangedPath = (run: WorkerRun, changedPath: string): string => {
  let normalized = changedPath.trim()
  if (normalized.length === 0) return ""
  if (path.isAbsolute(normalized) && run.workspace_path !== undefined) {
    const relative = path.relative(run.workspace_path, normalized)
    if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      normalized = relative
    }
  }
  return normalized.replace(/\\/g, "/").replace(/^\.\/+/, "")
}

const changedPathsForRun = (run: WorkerRun): ReadonlyArray<string> =>
  [
    ...(workerResult(run)?.changes_made.map((change) => change.path) ?? []),
    ...(run.patch_changed_files ?? []),
  ]
    .map((changedPath) => normalizeChangedPath(run, changedPath))
    .filter((changedPath) => changedPath.length > 0)

const detectConflicts = (runs: ReadonlyArray<WorkerRun>): ReadonlyArray<WorkerConflict> => {
  const byPath = new Map<string, Set<string>>()
  for (const run of runs) {
    if (run.status !== "completed" || run.mode !== "write-allowed") continue
    for (const changedPath of changedPathsForRun(run)) {
      const workers = byPath.get(changedPath) ?? new Set<string>()
      workers.add(run.worker_id)
      byPath.set(changedPath, workers)
    }
  }
  return [...byPath.entries()]
    .filter(([, workerIds]) => workerIds.size > 1)
    .map(([path, workerIds]) => ({
      path,
      worker_ids: [...workerIds].sort(),
    }))
}

const uniqueSorted = (values: Iterable<string>): ReadonlyArray<string> =>
  [...new Set(values)].sort()

const verificationBlockers = (runs: ReadonlyArray<WorkerRun>): ReadonlyArray<string> =>
  runs.flatMap((run) => {
    if (run.status !== "completed" || run.mode !== "write-allowed") return []
    const result = workerResult(run)
    if (changedPathsForRun(run).length === 0) return []
    const verification = result?.verification ?? []
    if (verification.length === 0) {
      return [`worker ${run.worker_id} changed files without verification evidence`]
    }
    const failed = verification.filter((check) => check.status !== "passed")
    return failed.map((check) =>
      `worker ${run.worker_id} verification not passed: ${check.check}=${check.status}`,
    )
  })

const integrationBlockers = (runs: ReadonlyArray<WorkerRun>): ReadonlyArray<string> =>
  runs.flatMap((run) => {
    if (run.status !== "completed" || run.mode !== "write-allowed") return []
    if (changedPathsForRun(run).length === 0) return []
    if (run.patch_path === undefined) {
      return [`worker ${run.worker_id} changed files without a captured isolated patch`]
    }
    if (run.integration_status === "applied") return []
    return [`worker ${run.worker_id} has pending integration`]
  })

export interface HistoricalWorkerRunKey {
  readonly agent_type: string
  readonly scope: string
  readonly prompt_hash: string
  readonly contract_version?: string
  readonly contract_hash?: string
}

export interface HistoricalWorkerPatternSummary {
  readonly key: HistoricalWorkerRunKey
  readonly pattern: string
  readonly count: number
  readonly worker_ids: ReadonlyArray<string>
  readonly session_ids: ReadonlyArray<string>
}

export interface SuccessfulVerifiedWorkerRunsSummary {
  readonly key: HistoricalWorkerRunKey
  readonly count: number
  readonly worker_ids: ReadonlyArray<string>
  readonly session_ids: ReadonlyArray<string>
  readonly verification_patterns: ReadonlyArray<string>
}

export interface HistoricalWorkerRunGroupSummary {
  readonly key: HistoricalWorkerRunKey
  readonly runs_total: number
  readonly session_ids: ReadonlyArray<string>
  readonly worker_ids: ReadonlyArray<string>
  readonly status_counts: Record<WorkerRun["status"], number>
  readonly failure_patterns: ReadonlyArray<string>
  readonly blocker_patterns: ReadonlyArray<string>
  readonly verification_patterns: ReadonlyArray<string>
  readonly repeated_failures: ReadonlyArray<HistoricalWorkerPatternSummary>
  readonly successful_verified_runs: SuccessfulVerifiedWorkerRunsSummary | null
}

export interface HistoricalWorkerAggregationOptions {
  readonly lastRuns?: number
  readonly lastSessions?: number
  readonly repeatedThreshold?: number
}

export interface HistoricalWorkerAggregationSummary {
  readonly runs_considered: number
  readonly sessions_considered: ReadonlyArray<string>
  readonly groups: ReadonlyArray<HistoricalWorkerRunGroupSummary>
  readonly repeated_failures: ReadonlyArray<HistoricalWorkerPatternSummary>
  readonly successful_verified_runs: ReadonlyArray<SuccessfulVerifiedWorkerRunsSummary>
}

type WorkerRunWithOptionalContract = WorkerRun & {
  readonly contract_version?: unknown
  readonly contract_hash?: unknown
}

const statusCounts = (): Record<WorkerRun["status"], number> => ({
  queued: 0,
  running: 0,
  blocked: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
})

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined

const historicalKeyForRun = (run: WorkerRun): HistoricalWorkerRunKey => {
  const withContract = run as WorkerRunWithOptionalContract
  const contractVersion = optionalString(withContract.contract_version)
  const contractHash = optionalString(withContract.contract_hash)
  return {
    agent_type: run.agent_type,
    scope: run.scope,
    prompt_hash: run.prompt_hash,
    ...(contractVersion === undefined ? {} : { contract_version: contractVersion }),
    ...(contractHash === undefined ? {} : { contract_hash: contractHash }),
  }
}

const keyId = (key: HistoricalWorkerRunKey): string =>
  JSON.stringify([
    key.agent_type,
    key.scope,
    key.prompt_hash,
    key.contract_version ?? "",
    key.contract_hash ?? "",
  ])

const timestampMs = (value: string | undefined): number => {
  if (value === undefined) return Number.NEGATIVE_INFINITY
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY
}

const runRecencyMs = (run: WorkerRun): number =>
  Math.max(
    timestampMs(run.integrated_at),
    timestampMs(run.stopped_at),
    timestampMs(run.started_at),
    timestampMs(run.created_at),
  )

const runsByRecencyAscending = (runs: ReadonlyArray<WorkerRun>): ReadonlyArray<WorkerRun> =>
  runs
    .map((run, index) => ({ run, index, recencyMs: runRecencyMs(run) }))
    .sort((left, right) => {
      if (left.recencyMs === right.recencyMs) return left.index - right.index
      return left.recencyMs < right.recencyMs ? -1 : 1
    })
    .map(({ run }) => run)

const selectHistoricalRuns = (
  runs: ReadonlyArray<WorkerRun>,
  options: HistoricalWorkerAggregationOptions,
): ReadonlyArray<WorkerRun> => {
  const orderedRuns = runsByRecencyAscending(runs)
  const runLimit = options.lastRuns === undefined
    ? orderedRuns.length
    : Math.max(0, Math.floor(options.lastRuns))
  if (runLimit === 0) return []
  const limitedRuns = orderedRuns.slice(-runLimit)
  if (options.lastSessions === undefined) return limitedRuns

  const sessionLimit = Math.max(0, Math.floor(options.lastSessions))
  if (sessionLimit === 0) return []
  const selectedSessions = new Set<string>()
  for (let index = limitedRuns.length - 1; index >= 0 && selectedSessions.size < sessionLimit; index -= 1) {
    selectedSessions.add(limitedRuns[index]!.session_id)
  }
  return limitedRuns.filter((run) => selectedSessions.has(run.session_id))
}

const normalizedPattern = (kind: "failure" | "blocker", value: string | undefined): string | null => {
  const normalized = value?.trim().replace(/\s+/g, " ")
  return normalized === undefined || normalized.length === 0 ? null : `${kind}:${normalized}`
}

const failedVerificationPatterns = (run: WorkerRun): ReadonlyArray<string> =>
  (workerResult(run)?.verification ?? [])
    .filter((check) => check.status !== "passed")
    .map((check) => `verification:${check.status}:${check.check}`)

const verificationPatterns = (run: WorkerRun): ReadonlyArray<string> =>
  (workerResult(run)?.verification ?? []).map((check) => `${check.status}:${check.check}`)

const isSuccessfulVerifiedRun = (run: WorkerRun): boolean => {
  if (run.status !== "completed") return false
  const verification = workerResult(run)?.verification ?? []
  return verification.length > 0 && verification.every((check) => check.status === "passed")
}

const repeatedPatternSummaries = (
  key: HistoricalWorkerRunKey,
  patternsByRun: ReadonlyArray<readonly [WorkerRun, string]>,
  repeatedThreshold: number,
): ReadonlyArray<HistoricalWorkerPatternSummary> => {
  const byPattern = new Map<string, Array<WorkerRun>>()
  const countedRunPatterns = new Set<string>()
  for (const [run, pattern] of patternsByRun) {
    const runPatternId = JSON.stringify([run.worker_id, pattern])
    if (countedRunPatterns.has(runPatternId)) continue
    countedRunPatterns.add(runPatternId)
    const entries = byPattern.get(pattern) ?? []
    entries.push(run)
    byPattern.set(pattern, entries)
  }

  return [...byPattern.entries()]
    .filter(([, patternRuns]) => patternRuns.length >= repeatedThreshold)
    .map(([pattern, patternRuns]) => ({
      key,
      pattern,
      count: patternRuns.length,
      worker_ids: uniqueSorted(patternRuns.map((run) => run.worker_id)),
      session_ids: uniqueSorted(patternRuns.map((run) => run.session_id)),
    }))
    .sort((left, right) => left.pattern.localeCompare(right.pattern))
}

export const summarizeHistoricalWorkerRuns = (
  runs: ReadonlyArray<WorkerRun>,
  options: HistoricalWorkerAggregationOptions = {},
): HistoricalWorkerAggregationSummary => {
  const selectedRuns = selectHistoricalRuns(runs, options)
  const repeatedThreshold = Math.max(2, Math.floor(options.repeatedThreshold ?? 2))
  const byKey = new Map<string, Array<WorkerRun>>()
  const keys = new Map<string, HistoricalWorkerRunKey>()

  for (const run of selectedRuns) {
    const key = historicalKeyForRun(run)
    const id = keyId(key)
    const entries = byKey.get(id) ?? []
    entries.push(run)
    byKey.set(id, entries)
    keys.set(id, key)
  }

  const groups = [...byKey.entries()]
    .map(([id, groupRuns]) => {
      const key = keys.get(id)!
      const counts = statusCounts()
      for (const run of groupRuns) {
        counts[run.status] += 1
      }

      const failurePatterns = groupRuns.flatMap((run) => {
        const pattern = normalizedPattern("failure", run.failure_reason)
        return pattern === null ? [] : [pattern]
      })
      const blockerPatterns = groupRuns.flatMap((run) => {
        const directBlocker = normalizedPattern("blocker", run.blocked_reason)
        const resultBlockers = (workerResult(run)?.blockers ?? [])
          .flatMap((blocker) => {
            const pattern = normalizedPattern("blocker", blocker)
            return pattern === null ? [] : [pattern]
          })
        return directBlocker === null ? resultBlockers : [directBlocker, ...resultBlockers]
      })
      const verification = groupRuns.flatMap(verificationPatterns)
      const repeatedFailures = repeatedPatternSummaries(
        key,
        groupRuns.flatMap((run) => [
          ...failurePatternsForRun(run),
          ...blockerPatternsForRun(run),
          ...failedVerificationPatterns(run),
        ].map((pattern) => [run, pattern] as const)),
        repeatedThreshold,
      )
      const verifiedRuns = groupRuns.filter(isSuccessfulVerifiedRun)
      const successfulVerifiedRuns = verifiedRuns.length === 0
        ? null
        : {
            key,
            count: verifiedRuns.length,
            worker_ids: uniqueSorted(verifiedRuns.map((run) => run.worker_id)),
            session_ids: uniqueSorted(verifiedRuns.map((run) => run.session_id)),
            verification_patterns: uniqueSorted(verifiedRuns.flatMap(verificationPatterns)),
          }

      return {
        key,
        runs_total: groupRuns.length,
        session_ids: uniqueSorted(groupRuns.map((run) => run.session_id)),
        worker_ids: uniqueSorted(groupRuns.map((run) => run.worker_id)),
        status_counts: counts,
        failure_patterns: uniqueSorted(failurePatterns),
        blocker_patterns: uniqueSorted(blockerPatterns),
        verification_patterns: uniqueSorted(verification),
        repeated_failures: repeatedFailures,
        successful_verified_runs: successfulVerifiedRuns,
      }
    })
    .sort((left, right) => keyId(left.key).localeCompare(keyId(right.key)))

  return {
    runs_considered: selectedRuns.length,
    sessions_considered: uniqueSorted(selectedRuns.map((run) => run.session_id)),
    groups,
    repeated_failures: groups.flatMap((group) => group.repeated_failures),
    successful_verified_runs: groups.flatMap((group) =>
      group.successful_verified_runs === null ? [] : [group.successful_verified_runs],
    ),
  }
}

const failurePatternsForRun = (run: WorkerRun): ReadonlyArray<string> => {
  if (run.status !== "failed" && run.status !== "blocked") return []
  const pattern = normalizedPattern("failure", run.failure_reason)
  return pattern === null ? [] : [pattern]
}

const blockerPatternsForRun = (run: WorkerRun): ReadonlyArray<string> => {
  if (run.status !== "failed" && run.status !== "blocked") return []
  const directBlocker = normalizedPattern("blocker", run.blocked_reason)
  const resultBlockers = (workerResult(run)?.blockers ?? []).flatMap((blocker) => {
    const pattern = normalizedPattern("blocker", blocker)
    return pattern === null ? [] : [pattern]
  })
  return directBlocker === null ? resultBlockers : [directBlocker, ...resultBlockers]
}

export const summarizeWorkerRuns = (
  sessionId: string,
  runs: ReadonlyArray<WorkerRun>,
  parentTaskId?: string,
): WorkerIntegrationSummary => {
  const conflicts = detectConflicts(runs)
  const queued = countStatus(runs, "queued")
  const running = countStatus(runs, "running")
  const blocked = countStatus(runs, "blocked")
  const failed = countStatus(runs, "failed")
  const activeWorkerIds = uniqueSorted(
    runs
      .filter((run) => run.status === "queued" || run.status === "running" || run.status === "blocked")
      .map((run) => run.worker_id),
  )
  const completedWorkerIds = uniqueSorted(
    runs.filter((run) => run.status === "completed").map((run) => run.worker_id),
  )
  const failedWorkerIds = uniqueSorted(
    runs.filter((run) => run.status === "failed").map((run) => run.worker_id),
  )
  const blockedWorkerIds = uniqueSorted(
    runs.filter((run) => run.status === "blocked").map((run) => run.worker_id),
  )
  const filesChanged = uniqueSorted(
    runs.flatMap(changedPathsForRun),
  )
  const latestIntegratedAt = runs
    .filter((run) => run.integration_status === "applied" && run.integrated_at !== undefined)
    .map((run) => run.integrated_at!)
    .sort()
    .at(-1)
  const risks = uniqueSorted(runs.flatMap((run) => workerResult(run)?.risks ?? []))
  const blockers = uniqueSorted([
    ...runs.flatMap((run) => workerResult(run)?.blockers ?? []),
    ...verificationBlockers(runs),
    ...integrationBlockers(runs),
    ...runs
      .filter((run) => run.status === "failed" || run.status === "blocked")
      .flatMap((run) => run.blocked_reason ?? run.failure_reason ?? []),
    ...conflicts.map((conflict) =>
      `conflict:${conflict.path}:${conflict.worker_ids.join(",")}`,
    ),
  ])
  const readyForIntegration =
    runs.length > 0 &&
    queued === 0 &&
    running === 0 &&
    blocked === 0 &&
    failed === 0 &&
    conflicts.length === 0 &&
    blockers.length === 0
  const integrationPlan = readyForIntegration
    ? [
        filesChanged.length > 0
          ? `review ${filesChanged.length} changed file(s): ${filesChanged.join(", ")}`
          : "review worker outputs; no file changes reported",
        "rerun final verification in the parent workspace before final handoff",
      ]
    : [
        activeWorkerIds.length > 0
          ? `resolve active workers: ${activeWorkerIds.join(", ")}`
          : "resolve worker blockers before integration",
        failedWorkerIds.length > 0
          ? `inspect failed workers: ${failedWorkerIds.join(", ")}`
          : "",
        conflicts.length > 0
          ? `resolve conflicting paths: ${conflicts.map((conflict) => conflict.path).join(", ")}`
          : "",
      ].filter((line) => line.length > 0)

  return {
    session_id: sessionId,
    ...(parentTaskId === undefined ? {} : { parent_task_id: parentTaskId }),
    workers_total: runs.length,
    queued,
    running,
    blocked,
    completed: countStatus(runs, "completed"),
    failed,
    cancelled: countStatus(runs, "cancelled"),
    active_worker_ids: activeWorkerIds,
    completed_worker_ids: completedWorkerIds,
    failed_worker_ids: failedWorkerIds,
    blocked_worker_ids: blockedWorkerIds,
    files_changed: filesChanged,
    risks,
    blockers,
    conflicts,
    integration_plan: integrationPlan,
    ...(latestIntegratedAt === undefined ? {} : { latest_integrated_at: latestIntegratedAt }),
    final_verification_required: readyForIntegration && filesChanged.length > 0,
    ready_for_integration: readyForIntegration,
  }
}

export const WorkerAggregationLive: Layer.Layer<
  WorkerAggregation,
  never,
  WorkerRuns
> =
  Layer.effect(
    WorkerAggregation,
    Effect.map(WorkerRuns, (runs) =>
      WorkerAggregation.of({
        summarizeSession: (sessionId) =>
          runs.forSession(sessionId).pipe(
            Effect.map((sessionRuns) => summarizeWorkerRuns(sessionId, sessionRuns)),
          ),
        summarizeParent: (parentTaskId) =>
          runs.forParent(parentTaskId).pipe(
            Effect.map((parentRuns) =>
              summarizeWorkerRuns(parentRuns[0]?.session_id ?? "unknown", parentRuns, parentTaskId),
            ),
          ),
      }),
    ),
  )
