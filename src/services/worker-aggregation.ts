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
