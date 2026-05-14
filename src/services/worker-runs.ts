import { Context, Effect, Layer, Schema, Stream } from "effect"
import * as crypto from "node:crypto"
import * as path from "node:path"
import { EventStoreError, WorkerRunError } from "../schema/errors.ts"
import { eventStream } from "../schema/events.ts"
import {
  WorkerResult,
  WorkerRun,
  type WorkerIsolation,
  type WorkerMode,
  type WorkerResult as WorkerResultType,
  type WorkerRun as WorkerRunType,
} from "../schema/worker-run.ts"
import { EventStore, collectStream } from "./event-store.ts"
import { logWarning } from "./diagnostics.ts"

const MAX_WORKER_RUN_RECORDS = 5_000

export interface WorkerRunCreate {
  readonly worker_id?: string
  readonly session_id: string
  readonly parent_task_id?: string
  readonly agent_id?: string
  readonly agent_type: string
  readonly mode: WorkerMode
  readonly prompt?: string
  readonly prompt_hash?: string
  readonly scope: string
  readonly created_at?: string
}

export interface WorkerRunCompletionMetadata {
  readonly isolation?: WorkerIsolation
  readonly workspace_path?: string
  readonly patch_path?: string
  readonly patch_changed_files?: ReadonlyArray<string>
}

export interface WorkerRunsApi {
  readonly createQueued: (input: WorkerRunCreate) => Effect.Effect<WorkerRunType, WorkerRunError | EventStoreError>
  readonly markRunning: (workerId: string, at?: string) => Effect.Effect<WorkerRunType, WorkerRunError | EventStoreError>
  readonly markBlocked: (workerId: string, reason: string, at?: string) => Effect.Effect<WorkerRunType, WorkerRunError | EventStoreError>
  readonly complete: (
    workerId: string,
    result: unknown,
    at?: string,
    metadata?: WorkerRunCompletionMetadata,
  ) => Effect.Effect<WorkerRunType, WorkerRunError | EventStoreError>
  readonly markIntegrated: (workerId: string, at?: string) => Effect.Effect<WorkerRunType, WorkerRunError | EventStoreError>
  readonly fail: (workerId: string, reason: string, at?: string) => Effect.Effect<WorkerRunType, WorkerRunError | EventStoreError>
  readonly cancel: (workerId: string, reason: string, at?: string) => Effect.Effect<WorkerRunType, WorkerRunError | EventStoreError>
  readonly get: (workerId: string) => Effect.Effect<WorkerRunType | null, EventStoreError>
  readonly findByAgent: (sessionId: string, agentId: string) => Effect.Effect<WorkerRunType | null, EventStoreError>
  readonly forSession: (sessionId: string, n?: number) => Effect.Effect<ReadonlyArray<WorkerRunType>, EventStoreError>
  readonly forParent: (parentTaskId: string, n?: number) => Effect.Effect<ReadonlyArray<WorkerRunType>, EventStoreError>
  readonly list: (n: number) => Effect.Effect<ReadonlyArray<WorkerRunType>, EventStoreError>
  readonly stream: (n: number) => Stream.Stream<WorkerRunType, EventStoreError>
}

export class WorkerRuns extends Context.Tag("WorkerRuns")<WorkerRuns, WorkerRunsApi>() {}

const latestByWorker = (records: ReadonlyArray<WorkerRunType>): ReadonlyArray<WorkerRunType> => {
  const byId = new Map<string, WorkerRunType>()
  for (const record of records) {
    byId.delete(record.worker_id)
    byId.set(record.worker_id, record)
  }
  return [...byId.values()]
}

export const workerRunsStream = (root: string = process.cwd()) =>
  eventStream(
    "worker-runs",
    path.join(root, ".claude-hooks", "state", "workers", "runs.jsonl"),
    WorkerRun,
    {
      maxRecords: MAX_WORKER_RUN_RECORDS,
      maxTailBytes: 16 * 1024 * 1024,
      strictTail: true,
      compactRecords: latestByWorker,
    },
  )

export const hashWorkerPrompt = (prompt: string): string =>
  crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16)

const nowIso = (): string => new Date().toISOString()

const generatedWorkerId = (): string => `worker-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}

export const scopedWorkerRunId = (sessionId: string, workerId: string): string =>
  `${sessionId}:${workerId}`

const workerError = (
  op: string,
  message: string,
  workerId?: string,
  cause?: unknown,
): WorkerRunError => {
  const payload: {
    readonly op: string
    readonly workerId?: string
    readonly message: string
    readonly cause?: unknown
  } = {
    op,
    message,
    ...(workerId === undefined ? {} : { workerId }),
    ...(cause === undefined ? {} : { cause }),
  }
  return new WorkerRunError(payload)
}

const decodeWorkerResult = (workerId: string, result: unknown): Effect.Effect<WorkerResultType, WorkerRunError> =>
  Schema.decodeUnknown(WorkerResult)(result).pipe(
    Effect.mapError((cause) =>
      workerError("worker-runs.complete", "worker result schema decode failed", workerId, cause),
    ),
  )

const validateCompletionMetadata = (
  workerId: string,
  metadata: WorkerRunCompletionMetadata,
): Effect.Effect<WorkerRunCompletionMetadata, WorkerRunError> => {
  if (metadata.patch_path !== undefined && metadata.patch_path.trim().length === 0) {
    return Effect.fail(workerError("worker-runs.complete", "patch_path cannot be blank", workerId))
  }
  return Effect.succeed(metadata)
}

const clampLimit = (n: number): number => Math.min(Math.max(0, n), MAX_WORKER_RUN_RECORDS)

const clearRunTerminalFields = (run: WorkerRunType): WorkerRunType => {
  const {
    failure_reason: _failure,
    blocked_reason: _blocked,
    output: _output,
    result: _result,
    stopped_at: _stopped,
    isolation: _isolation,
    workspace_path: _workspacePath,
    patch_path: _patchPath,
    patch_changed_files: _patchChangedFiles,
    integration_status: _integrationStatus,
    integrated_at: _integratedAt,
    ...base
  } = run
  return base
}

const clearRunFailureFields = (run: WorkerRunType): WorkerRunType => {
  const { failure_reason: _failure, blocked_reason: _blocked, ...base } = run
  return base
}

const clearRunCompletionFields = (run: WorkerRunType): WorkerRunType => {
  const {
    failure_reason: _failure,
    blocked_reason: _blocked,
    output: _output,
    result: _result,
    isolation: _isolation,
    workspace_path: _workspacePath,
    patch_path: _patchPath,
    patch_changed_files: _patchChangedFiles,
    integration_status: _integrationStatus,
    integrated_at: _integratedAt,
    ...base
  } = run
  return base
}

const terminalStatuses = new Set<WorkerRunType["status"]>(["completed", "failed", "cancelled"])

const ensureNotTerminal = (
  op: string,
  run: WorkerRunType,
): Effect.Effect<void, WorkerRunError> =>
  terminalStatuses.has(run.status)
    ? Effect.fail(workerError(op, `worker run is terminal (${run.status})`, run.worker_id))
    : Effect.void

const ensureStatus = (
  op: string,
  run: WorkerRunType,
  statuses: ReadonlyArray<WorkerRunType["status"]>,
): Effect.Effect<void, WorkerRunError> =>
  statuses.includes(run.status)
    ? Effect.void
    : Effect.fail(workerError(op, `worker run is ${run.status}; expected ${statuses.join(" or ")}`, run.worker_id))

export const WorkerRunsLive = (root: string = process.cwd()): Layer.Layer<WorkerRuns, never, EventStore> =>
  Layer.effect(
    WorkerRuns,
    Effect.gen(function* () {
      const store = yield* EventStore
      const stream = workerRunsStream(root)
      const mutationGate = yield* Effect.makeSemaphore(1)
      const guarded = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        mutationGate.withPermits(1)(effect)
      const readLatest = (workerId: string) =>
        collectStream(store.tail(stream, MAX_WORKER_RUN_RECORDS)).pipe(
          Effect.map((records) => {
            for (let i = records.length - 1; i >= 0; i--) {
              const record = records[i]
              if (record?.worker_id === workerId) return record
            }
            return null
          }),
        )
      const requireLatest = (workerId: string, op: string) =>
        readLatest(workerId).pipe(
          Effect.flatMap((run) =>
            run === null
              ? Effect.fail(workerError(op, "worker run not found", workerId))
              : Effect.succeed(run),
          ),
        )
      const appendRun = (run: WorkerRunType) =>
        store.append(stream, run).pipe(
          Effect.zipRight(
            store.compact(stream.name).pipe(
              Effect.catchAll((cause) =>
                logWarning(
                  `[worker-runs] compact failed after append; keeping uncompacted ledger: ${cause.message}`,
                ),
              ),
            ),
          ),
          Effect.as(run),
        )
      const sameObservedRun = (left: WorkerRunType, right: WorkerRunType): boolean =>
        left.status === right.status &&
        left.attempts === right.attempts &&
        left.started_at === right.started_at &&
        left.stopped_at === right.stopped_at &&
        left.failure_reason === right.failure_reason &&
        left.blocked_reason === right.blocked_reason &&
        left.integration_status === right.integration_status &&
        left.integrated_at === right.integrated_at
      const sameStringArray = (
        left: ReadonlyArray<string> | undefined,
        right: ReadonlyArray<string> | undefined,
      ): boolean =>
        (left ?? []).length === (right ?? []).length &&
        (left ?? []).every((value, index) => value === (right ?? [])[index])
      const sameCompletion = (
        run: WorkerRunType,
        output: WorkerResultType,
        metadata: WorkerRunCompletionMetadata,
      ): boolean =>
        stableJson(run.result ?? run.output) === stableJson(output) &&
        (run.isolation ?? undefined) === (metadata.isolation ?? undefined) &&
        (run.workspace_path ?? undefined) === (metadata.workspace_path ?? undefined) &&
        (run.patch_path ?? undefined) === (metadata.patch_path ?? undefined) &&
        sameStringArray(run.patch_changed_files, metadata.patch_changed_files)
      const latestRecords = (n = MAX_WORKER_RUN_RECORDS) =>
        collectStream(store.tail(stream, MAX_WORKER_RUN_RECORDS)).pipe(
          Effect.map((records) => latestByWorker(records).slice(-clampLimit(n))),
        )
      const transition = (
        workerId: string,
        op: string,
        patch: (run: WorkerRunType) => Effect.Effect<WorkerRunType, WorkerRunError>,
      ): Effect.Effect<WorkerRunType, WorkerRunError | EventStoreError> =>
        guarded(
          requireLatest(workerId, op).pipe(
            Effect.flatMap((run) => patch(run).pipe(Effect.map((next) => ({ run, next })))),
            Effect.flatMap(({ run, next }) => {
              if (next === run) return Effect.succeed(run)
              return readLatest(workerId).pipe(
                Effect.flatMap((latest): Effect.Effect<WorkerRunType, WorkerRunError | EventStoreError> => {
                  if (
                    latest !== null &&
                    !sameObservedRun(run, latest) &&
                    terminalStatuses.has(latest.status)
                  ) {
                    return Effect.fail(
                      workerError(
                        op,
                        `worker run changed to terminal status (${latest.status}) before transition could be recorded`,
                        workerId,
                      ),
                    )
                  }
                  return appendRun(next)
                }),
              )
            }),
          ),
        )

      return WorkerRuns.of({
        createQueued: (input) => {
          const workerId = input.worker_id ?? generatedWorkerId()
          return guarded(Effect.gen(function* () {
            const existing = yield* readLatest(workerId)
            if (existing !== null) {
              return yield* Effect.fail(
                workerError("worker-runs.createQueued", "worker run already exists", workerId),
              )
            }
            const promptHash =
              input.prompt_hash ?? (input.prompt === undefined ? undefined : hashWorkerPrompt(input.prompt))
            if (promptHash === undefined) {
              return yield* Effect.fail(workerError("worker-runs.createQueued", "prompt or prompt_hash is required"))
            }
            return yield* appendRun({
              worker_id: workerId,
              session_id: input.session_id,
              ...(input.parent_task_id === undefined ? {} : { parent_task_id: input.parent_task_id }),
              ...(input.agent_id === undefined ? {} : { agent_id: input.agent_id }),
              agent_type: input.agent_type,
              mode: input.mode,
              status: "queued",
              prompt_hash: promptHash,
              scope: input.scope,
              created_at: input.created_at ?? nowIso(),
              attempts: 0,
            })
          }))
        },
        markRunning: (workerId, at = nowIso()) =>
          transition(workerId, "worker-runs.markRunning", (run) =>
            run.status === "running"
              ? Effect.succeed({
                  ...clearRunTerminalFields(run),
                  status: "running" as const,
                  started_at: at,
                  attempts: run.attempts + 1,
                })
              : ensureNotTerminal("worker-runs.markRunning", run).pipe(
                  Effect.as({
                    ...clearRunTerminalFields(run),
                    status: "running" as const,
                    started_at: at,
                    attempts: run.attempts + 1,
                  }),
                ),
          ),
        markBlocked: (workerId, reason, at = nowIso()) =>
          transition(workerId, "worker-runs.markBlocked", (run) =>
            ensureNotTerminal("worker-runs.markBlocked", run).pipe(
              Effect.as({
                ...run,
                status: "blocked" as const,
                stopped_at: at,
                failure_reason: reason,
                blocked_reason: reason,
              }),
            ),
          ),
        complete: (workerId, result, at = nowIso(), metadata = {}) =>
          validateCompletionMetadata(workerId, metadata).pipe(
            Effect.zipRight(decodeWorkerResult(workerId, result)),
            Effect.flatMap((output) =>
              transition(workerId, "worker-runs.complete", (run) =>
                run.status === "completed"
                  ? sameCompletion(run, output, metadata)
                    ? Effect.succeed(run)
                    : Effect.fail(
                        workerError(
                          "worker-runs.complete",
                          "worker run is already completed with different result or metadata",
                          workerId,
                        ),
                      )
                  : ensureStatus("worker-runs.complete", run, ["queued", "running", "blocked"]).pipe(
                      Effect.as({
                        ...clearRunCompletionFields(run),
                        status: "completed" as const,
                        stopped_at: at,
                        ...(metadata.isolation === undefined ? {} : { isolation: metadata.isolation }),
                        ...(metadata.workspace_path === undefined ? {} : { workspace_path: metadata.workspace_path }),
                        ...(metadata.patch_path === undefined ? {} : { patch_path: metadata.patch_path }),
                        ...(metadata.patch_changed_files === undefined
                          ? {}
                          : { patch_changed_files: [...metadata.patch_changed_files] }),
                        output,
                        result: output,
                        ...(metadata.patch_path === undefined
                          ? {}
                          : { integration_status: "pending" as const }),
                      }),
                    ),
              ),
            ),
          ),
        markIntegrated: (workerId, at = nowIso()) =>
          guarded(Effect.gen(function* () {
            const run = yield* requireLatest(workerId, "worker-runs.markIntegrated")
            if (run.status !== "completed") {
              return yield* Effect.fail(
                workerError("worker-runs.markIntegrated", `worker run is ${run.status}, not completed`, workerId),
              )
            }
            if (run.mode !== "write-allowed") {
              return yield* Effect.fail(
                workerError("worker-runs.markIntegrated", "read-only worker has no patch to integrate", workerId),
              )
            }
            if (run.patch_path === undefined || run.patch_path.trim().length === 0) {
              return yield* Effect.fail(
                workerError("worker-runs.markIntegrated", "worker completed without a captured patch", workerId),
              )
            }
            return yield* appendRun({
              ...run,
              integration_status: "applied",
              integrated_at: at,
            })
          })),
        fail: (workerId, reason, at = nowIso()) =>
          transition(workerId, "worker-runs.fail", (run) =>
            ensureNotTerminal("worker-runs.fail", run).pipe(
              Effect.as({
                ...clearRunTerminalFields(run),
                status: "failed" as const,
                stopped_at: at,
                failure_reason: reason,
              }),
            ),
          ),
        cancel: (workerId, reason, at = nowIso()) =>
          transition(workerId, "worker-runs.cancel", (run) =>
            run.status === "cancelled"
              ? Effect.succeed(run)
              : ensureStatus("worker-runs.cancel", run, ["queued", "running", "blocked", "failed"]).pipe(
                  Effect.as({
                    ...clearRunTerminalFields(run),
                    status: "cancelled" as const,
                    stopped_at: at,
                    failure_reason: reason,
                  }),
                ),
          ),
        get: readLatest,
        findByAgent: (sessionId, agentId) =>
          latestRecords().pipe(
            Effect.map((records) =>
              records.find((run) => run.session_id === sessionId && run.agent_id === agentId) ?? null,
            ),
          ),
        forSession: (sessionId, n = MAX_WORKER_RUN_RECORDS) =>
          latestRecords().pipe(
            Effect.map((records) =>
              records
                .filter((run) => run.session_id === sessionId)
                .slice(-clampLimit(n)),
            ),
          ),
        forParent: (parentTaskId, n = MAX_WORKER_RUN_RECORDS) =>
          latestRecords().pipe(
            Effect.map((records) =>
              records
                .filter((run) => run.parent_task_id === parentTaskId)
                .slice(-clampLimit(n)),
            ),
          ),
        list: (n) =>
          latestRecords(n),
        stream: (n) => store.tail(stream, clampLimit(n)),
      })
    }),
  )
