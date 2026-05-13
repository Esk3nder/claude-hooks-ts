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

export const workerRunsStream = (root: string = process.cwd()) =>
  eventStream(
    "worker-runs",
    path.join(root, ".claude-hooks", "state", "workers", "runs.jsonl"),
    WorkerRun,
    { maxRecords: MAX_WORKER_RUN_RECORDS },
  )

export const hashWorkerPrompt = (prompt: string): string =>
  crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16)

const nowIso = (): string => new Date().toISOString()

const generatedWorkerId = (): string => `worker-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`

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

const latestByWorker = (records: ReadonlyArray<WorkerRunType>): ReadonlyArray<WorkerRunType> => {
  const byId = new Map<string, WorkerRunType>()
  for (const record of records) {
    byId.delete(record.worker_id)
    byId.set(record.worker_id, record)
  }
  return [...byId.values()]
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
    integration_status: _integrationStatus,
    integrated_at: _integratedAt,
    ...base
  } = run
  return base
}

export const WorkerRunsLive = (root: string = process.cwd()): Layer.Layer<WorkerRuns, never, EventStore> =>
  Layer.effect(
    WorkerRuns,
    Effect.gen(function* () {
      const store = yield* EventStore
      const stream = workerRunsStream(root)
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
      const appendRun = (run: WorkerRunType) => store.append(stream, run).pipe(Effect.as(run))
      const latestRecords = (n = MAX_WORKER_RUN_RECORDS) =>
        collectStream(store.tail(stream, MAX_WORKER_RUN_RECORDS)).pipe(
          Effect.map((records) => latestByWorker(records).slice(-clampLimit(n))),
        )
      const transition = (
        workerId: string,
        op: string,
        patch: (run: WorkerRunType) => WorkerRunType,
      ) =>
        requireLatest(workerId, op).pipe(Effect.flatMap((run) => appendRun(patch(run))))

      return WorkerRuns.of({
        createQueued: (input) => {
          const workerId = input.worker_id ?? generatedWorkerId()
          return Effect.gen(function* () {
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
          })
        },
        markRunning: (workerId, at = nowIso()) =>
          transition(workerId, "worker-runs.markRunning", (run) => ({
            ...clearRunTerminalFields(run),
            status: "running",
            started_at: at,
            attempts: run.attempts + 1,
          })),
        markBlocked: (workerId, reason, at = nowIso()) =>
          transition(workerId, "worker-runs.markBlocked", (run) => ({
            ...run,
            status: "blocked",
            stopped_at: at,
            failure_reason: reason,
            blocked_reason: reason,
          })),
        complete: (workerId, result, at = nowIso(), metadata = {}) =>
          validateCompletionMetadata(workerId, metadata).pipe(
            Effect.zipRight(decodeWorkerResult(workerId, result)),
            Effect.flatMap((output) =>
              transition(workerId, "worker-runs.complete", (run) => ({
                ...clearRunCompletionFields(run),
                status: "completed",
                stopped_at: at,
                ...(metadata.isolation === undefined ? {} : { isolation: metadata.isolation }),
                ...(metadata.workspace_path === undefined ? {} : { workspace_path: metadata.workspace_path }),
                ...(metadata.patch_path === undefined ? {} : { patch_path: metadata.patch_path }),
                output,
                result: output,
                ...(metadata.patch_path === undefined
                  ? {}
                  : { integration_status: "pending" as const }),
              })),
            ),
          ),
        markIntegrated: (workerId, at = nowIso()) =>
          Effect.gen(function* () {
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
          }),
        fail: (workerId, reason, at = nowIso()) =>
          transition(workerId, "worker-runs.fail", (run) => ({
            ...clearRunTerminalFields(run),
            status: "failed",
            stopped_at: at,
            failure_reason: reason,
          })),
        cancel: (workerId, reason, at = nowIso()) =>
          transition(workerId, "worker-runs.cancel", (run) => ({
            ...clearRunTerminalFields(run),
            status: "cancelled",
            stopped_at: at,
            failure_reason: reason,
          })),
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
