import { Context, Effect, Layer, Option, Schedule, Schema } from "effect"
import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
  WorkerJobPayload,
  WorkerResult,
  type WorkerIsolation,
  type WorkerJobPayload as WorkerJobPayloadType,
  type WorkerResult as WorkerResultType,
  type WorkerRun as WorkerRunType,
} from "../schema/worker-run.ts"
import { EventStoreError, WorkerRunError } from "../schema/errors.ts"
import type { WorkerJob } from "../schema/events.ts"
import { ClaudeSubprocess } from "./claude-subprocess.ts"
import { CommandRunner } from "./command-runner.ts"
import { durationMillis, loadRuntimeConfig } from "./runtime-config.ts"
import { WorkerQueue } from "./worker-queue.ts"
import { hashWorkerPrompt, WorkerRuns } from "./worker-runs.ts"
import { safeStateSegment } from "./state-paths.ts"

export interface WorkerExecutionJob extends WorkerJobPayloadType {
  readonly worker_id: string
  readonly timeout_ms: number
  readonly state_root?: string
}

export interface WorkerExecutorApi {
  readonly run: (job: WorkerExecutionJob) => Effect.Effect<unknown, WorkerRunError>
}

export class WorkerExecutor extends Context.Tag("WorkerExecutor")<
  WorkerExecutor,
  WorkerExecutorApi
>() {}

export interface WorkerSupervisorApi {
  readonly enqueue: (
    input: WorkerJobPayloadType,
  ) => Effect.Effect<WorkerRunType, WorkerRunError | EventStoreError>
  readonly runOne: Effect.Effect<WorkerRunType, WorkerRunError | EventStoreError>
  /** Bounded drain: runs up to `count` available jobs and returns once the queue is briefly idle. */
  readonly runN: (count: number) => Effect.Effect<ReadonlyArray<WorkerRunType>, WorkerRunError | EventStoreError>
}

export class WorkerSupervisor extends Context.Tag("WorkerSupervisor")<
  WorkerSupervisor,
  WorkerSupervisorApi
>() {}

const generatedWorkerId = (): string =>
  `worker-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`

const MAX_WORKER_PATCH_BYTES = 5_000_000

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

const decodePayload = (
  job: WorkerJob,
): Effect.Effect<WorkerJobPayloadType, WorkerRunError> =>
  Schema.decodeUnknown(WorkerJobPayload)(job.payload).pipe(
    Effect.mapError((cause) =>
      workerError("worker-supervisor.decode", "worker job payload schema decode failed", job.id, cause),
    ),
  )

const positiveInt = (value: number | undefined, fallback: number): number =>
  Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback

export const workerRetrySchedule = (retryLimit: number) =>
  Schedule.intersect(
    Schedule.recurs(Math.max(0, retryLimit)),
    Schedule.intersect(Schedule.exponential("10 millis"), Schedule.spaced("10 millis")),
  )

const summarizeWorkerFailure = (cause: unknown): string => {
  if (cause instanceof WorkerRunError) return `${cause.op}: ${cause.message}`
  if (cause instanceof EventStoreError) return `${cause.op}: ${cause.message}`
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`.slice(0, 240)
  return String(cause).slice(0, 240)
}

const jobForPayload = (
  payload: WorkerJobPayloadType,
  workerId: string,
): WorkerJob => ({
  id: workerId,
  queue: "default",
  payload: {
    ...payload,
    worker_id: workerId,
    prompt_hash: promptHashForPayload(payload),
  },
  enqueuedAt: Date.now(),
  attempts: 0,
})

const promptHashForPayload = (payload: WorkerJobPayloadType): string =>
  payload.prompt_hash ?? hashWorkerPrompt(payload.prompt)

const payloadCompatibleWithRun = (
  payload: WorkerJobPayloadType,
  workerId: string,
  run: WorkerRunType,
): boolean =>
  run.worker_id === workerId &&
  run.session_id === payload.session_id &&
  run.agent_type === payload.agent_type &&
  run.mode === payload.mode &&
  run.prompt_hash === promptHashForPayload(payload) &&
  run.scope === payload.scope &&
  (run.parent_task_id ?? undefined) === (payload.parent_task_id ?? undefined) &&
  (run.agent_id ?? undefined) === (payload.agent_id ?? undefined)

const sanitizedPathPart = (value: string): string => safeStateSegment(value, "worker")

const isTerminalRun = (run: WorkerRunType): boolean =>
  run.status === "completed" || run.status === "failed" || run.status === "cancelled"

const runGitText = (
  runner: CommandRunner["Type"],
  args: ReadonlyArray<string>,
  cwd: string,
  workerId: string,
  op: string,
  opts: { readonly stdin?: string; readonly stdoutMaxBytes?: number; readonly timeoutMs?: number } = {},
): Effect.Effect<string, WorkerRunError> =>
  runner
    .run("git", args, {
      cwd,
      ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
      timeoutMs: opts.timeoutMs ?? 30_000,
      stdoutMaxBytes: opts.stdoutMaxBytes ?? 200_000,
      stderrMaxBytes: 200_000,
    })
    .pipe(
      Effect.flatMap((result) => {
        if (result.timedOut) {
          return Effect.fail(
            workerError(op, `git ${args.join(" ")} timed out`, workerId, result),
          )
        }
        if (result.exitCode !== 0) {
          const detail = (result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} exited ${result.exitCode}`)
            .slice(0, 500)
          return Effect.fail(workerError(op, detail, workerId, result))
        }
        return Effect.succeed(result.stdout)
      }),
      Effect.mapError((cause) =>
        cause instanceof WorkerRunError
          ? cause
          : workerError(op, String(cause), workerId, cause),
      ),
    )

const workerPatchPath = (repoRoot: string, workerId: string): string =>
  path.join(repoRoot, ".claude-hooks", "state", "workers", "patches", `${sanitizedPathPart(workerId)}.patch`)

const writeWorkerPatch = (
  repoRoot: string,
  workerId: string,
  diff: string,
): Effect.Effect<string | undefined, WorkerRunError> => {
  if (diff.trim().length === 0) return Effect.succeed(undefined)
  if (Buffer.byteLength(diff, "utf8") >= MAX_WORKER_PATCH_BYTES) {
    return Effect.fail(
      workerError(
        "worker-supervisor.patch",
        `worker patch exceeded ${MAX_WORKER_PATCH_BYTES} bytes; refusing to persist truncated integration data`,
        workerId,
      ),
    )
  }
  const patchPath = workerPatchPath(repoRoot, workerId)
  return Effect.tryPromise({
    try: async () => {
      await fs.mkdir(path.dirname(patchPath), { recursive: true })
      await fs.writeFile(patchPath, diff, "utf8")
      return patchPath
    },
    catch: (cause) =>
      workerError("worker-supervisor.patch", "failed to persist worker patch", workerId, cause),
  })
}

const parseChangedFiles = (stdout: string): ReadonlyArray<string> =>
  [...new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0))].sort()

const acquireWorkerWorktree = (
  runner: CommandRunner["Type"],
  workerId: string,
  cwd: string,
): Effect.Effect<{ readonly repoRoot: string; readonly worktreePath: string }, WorkerRunError> =>
  Effect.gen(function* () {
    const repoRoot = (yield* runGitText(
      runner,
      ["rev-parse", "--show-toplevel"],
      cwd,
      workerId,
      "worker-supervisor.worktree",
    )).trim()
    const status = yield* runGitText(
      runner,
      ["status", "--porcelain"],
      repoRoot,
      workerId,
      "worker-supervisor.worktree",
    )
    if (status.trim().length > 0) {
      return yield* Effect.fail(
        workerError(
          "worker-supervisor.worktree",
          "worktree isolation requires a clean source worktree; use serial isolation for dirty local changes",
          workerId,
        ),
      )
    }
    const worktreePath = path.join(
      os.tmpdir(),
      "claude-hooks-workers",
      `${sanitizedPathPart(workerId)}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    )
    yield* fsEffect(
      () => fs.mkdir(path.dirname(worktreePath), { recursive: true }),
      workerId,
      "worker-supervisor.worktree",
      "failed to prepare worker worktree directory",
    )
    yield* runGitText(
      runner,
      ["worktree", "add", "--detach", worktreePath, "HEAD"],
      repoRoot,
      workerId,
      "worker-supervisor.worktree",
    )
    return { repoRoot, worktreePath }
  })

const fsEffect = <A>(
  run: () => Promise<A>,
  workerId: string,
  op: string,
  message: string,
): Effect.Effect<A, WorkerRunError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => workerError(op, message, workerId, cause),
  })

const removeWorkerWorktree = (
  runner: CommandRunner["Type"],
  workerId: string,
  repoRoot: string,
  worktreePath: string,
): Effect.Effect<void> =>
  runner
    .run("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repoRoot,
      timeoutMs: 30_000,
      stdoutMaxBytes: 50_000,
      stderrMaxBytes: 50_000,
    })
    .pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.void
          : fsEffect(
              () => fs.rm(worktreePath, { recursive: true, force: true }),
              workerId,
              "worker-supervisor.worktree",
              "failed to remove worker worktree",
            ).pipe(Effect.orElse(() => Effect.void)),
      ),
      Effect.catchAll(() =>
        fsEffect(
          () => fs.rm(worktreePath, { recursive: true, force: true }),
          workerId,
          "worker-supervisor.worktree",
          "failed to remove worker worktree",
        ).pipe(Effect.orElse(() => Effect.void)),
      ),
    )

interface WorkerExecutionOutcome {
  readonly result: unknown
  readonly metadata: {
    readonly isolation: WorkerIsolation
    readonly workspace_path?: string
    readonly patch_path?: string
    readonly patch_changed_files?: ReadonlyArray<string>
  }
}

const runWithWorktreeIsolation = (
  runner: CommandRunner["Type"],
  executor: WorkerExecutor["Type"],
  job: WorkerExecutionJob,
  isolation: WorkerIsolation,
): Effect.Effect<WorkerExecutionOutcome, WorkerRunError> => {
  const sourceCwd = job.cwd ?? process.cwd()
  return Effect.acquireUseRelease(
    acquireWorkerWorktree(runner, job.worker_id, sourceCwd),
    ({ repoRoot, worktreePath }) =>
      Effect.gen(function* () {
        const result = yield* executor.run({ ...job, cwd: worktreePath, state_root: repoRoot })
        yield* runGitText(
          runner,
          ["add", "-A"],
          worktreePath,
          job.worker_id,
          "worker-supervisor.patch",
        )
        const diff = yield* runGitText(
          runner,
          ["diff", "--cached", "--binary"],
          worktreePath,
          job.worker_id,
          "worker-supervisor.patch",
          { stdoutMaxBytes: MAX_WORKER_PATCH_BYTES },
        )
        const changedFiles = parseChangedFiles(
          yield* runGitText(
            runner,
            ["diff", "--cached", "--name-only"],
            worktreePath,
            job.worker_id,
            "worker-supervisor.patch",
            { stdoutMaxBytes: 200_000 },
          ),
        )
        const patchPath = yield* writeWorkerPatch(repoRoot, job.worker_id, diff)
        return {
          result,
          metadata: {
            isolation,
            workspace_path: worktreePath,
            ...(patchPath === undefined ? {} : { patch_path: patchPath }),
            ...(changedFiles.length === 0 ? {} : { patch_changed_files: changedFiles }),
          },
        }
      }),
    ({ repoRoot, worktreePath }) =>
      removeWorkerWorktree(runner, job.worker_id, repoRoot, worktreePath),
  )
}

export const parseWorkerResultText = (
  workerId: string,
  text: string,
): Effect.Effect<WorkerResultType, WorkerRunError> => {
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const candidate = (fenced?.[1] ?? trimmed).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch (cause) {
    return Effect.fail(
      workerError("worker-executor.parse", "worker output was not valid JSON", workerId, cause),
    )
  }
  return Schema.decodeUnknown(WorkerResult)(parsed).pipe(
    Effect.mapError((cause) =>
      workerError("worker-executor.parse", "worker output did not match WorkerResult", workerId, cause),
    ),
  )
}

const WORKER_SYSTEM_PROMPT = [
  "Return only JSON matching this WorkerResult contract:",
  "{summary, files_relevant:[{path,lines?,reason}], changes_made:[{path,summary,diff_ref?}], commands_run:[{command,exit_code?,result}], verification:[{check,status,evidence}], risks, blockers, confidence, next_action?}.",
  "Do not include markdown outside the JSON object.",
].join(" ")

export const WorkerExecutorLive: Layer.Layer<WorkerExecutor, never, ClaudeSubprocess> =
  Layer.effect(
    WorkerExecutor,
    Effect.map(ClaudeSubprocess, (claude) =>
      WorkerExecutor.of({
        run: (job) =>
          job.prompt_redacted === true
            ? Effect.fail(
                workerError(
                  "worker-executor.prompt",
                  "worker prompt was redacted for persistence and cannot be executed; re-enqueue with the original prompt",
                  job.worker_id,
                ),
              )
            : claude
            .spawn(
              [
                "--print",
                "--output-format",
                "text",
                "--system-prompt",
                WORKER_SYSTEM_PROMPT,
              ],
              {
                stdin: job.prompt,
                timeoutMs: job.timeout_ms,
                ...(job.cwd === undefined ? {} : { cwd: job.cwd }),
                env: {
                  CLAUDE_HOOKS_WORKER_ID: job.worker_id,
                  CLAUDE_HOOKS_SESSION_ID: job.session_id,
                  ...(job.agent_id === undefined ? {} : { CLAUDE_HOOKS_WORKER_AGENT_ID: job.agent_id }),
                  ...(job.state_root === undefined ? {} : { CLAUDE_HOOKS_STATE_ROOT: job.state_root }),
                },
              },
            )
            .pipe(
              Effect.mapError((cause) =>
                workerError("worker-executor.spawn", cause.message, job.worker_id, cause),
              ),
              Effect.flatMap((result) => {
                if (result.timedOut) {
                  return Effect.fail(
                    workerError(
                      "worker-executor.spawn",
                      `worker timed out after ${job.timeout_ms}ms`,
                      job.worker_id,
                    ),
                  )
                }
                if (result.exitCode !== 0) {
                  return Effect.fail(
                    workerError(
                      "worker-executor.spawn",
                      `worker subprocess exited ${result.exitCode}`,
                      job.worker_id,
                      result.stderr,
                    ),
                  )
                }
                return parseWorkerResultText(job.worker_id, result.stdout)
              }),
            ),
      }),
    ),
  )

export const WorkerExecutorTest = (
  responder: (job: WorkerExecutionJob) => unknown = () => ({
    summary: "worker completed",
    files_relevant: [],
    changes_made: [],
    commands_run: [],
    verification: [
      {
        check: "test executor",
        status: "passed",
        evidence: "WorkerExecutorTest returned a valid result",
      },
    ],
    risks: [],
    blockers: [],
    confidence: "high",
  }),
): Layer.Layer<WorkerExecutor> =>
  Layer.succeed(
    WorkerExecutor,
    WorkerExecutor.of({
      run: (job) => Effect.sync(() => responder(job)),
    }),
  )

export const WorkerSupervisorLive: Layer.Layer<
  WorkerSupervisor,
  never,
  WorkerQueue | WorkerRuns | WorkerExecutor | CommandRunner
> =
  Layer.effect(
    WorkerSupervisor,
    Effect.gen(function* () {
      const queue = yield* WorkerQueue
      const runs = yield* WorkerRuns
      const executor = yield* WorkerExecutor
      const runner = yield* CommandRunner
      const writeGate = yield* Effect.makeSemaphore(1)

      const ensureQueued = (payload: WorkerJobPayloadType, workerId: string) =>
        runs.get(workerId).pipe(
          Effect.flatMap((existing) =>
            existing === null
              ? runs.createQueued({
                  worker_id: workerId,
                  session_id: payload.session_id,
                  ...(payload.parent_task_id === undefined ? {} : { parent_task_id: payload.parent_task_id }),
                  ...(payload.agent_id === undefined ? {} : { agent_id: payload.agent_id }),
                  agent_type: payload.agent_type,
                  mode: payload.mode,
                  prompt_hash: promptHashForPayload(payload),
                  scope: payload.scope,
                })
              : payloadCompatibleWithRun(payload, workerId, existing)
                ? Effect.succeed(existing)
                : Effect.fail(
                    workerError(
                      "worker-supervisor.ensureQueued",
                      "worker id already exists with incompatible payload",
                      workerId,
                    ),
                  ),
          ),
        )

      const runDecoded = (payload: WorkerJobPayloadType, workerId: string) =>
        Effect.gen(function* () {
          const config = yield* loadRuntimeConfig
          if (!config.workersEnabled) {
            return yield* Effect.fail(
              workerError("worker-supervisor.runOne", "workers are disabled by runtime config", workerId),
            )
          }
          const queued = yield* ensureQueued(payload, workerId)
          if (isTerminalRun(queued)) return queued
          if (payload.prompt_redacted === true) {
            const reason = "worker prompt was redacted for persistence and cannot be executed; re-enqueue with the original prompt"
            yield* runs.fail(workerId, reason)
            return yield* Effect.fail(workerError("worker-supervisor.prompt", reason, workerId))
          }
          const timeoutMs = positiveInt(payload.timeout_ms, durationMillis(config.workerDefaultTimeoutMs))
          const maxAttempts = positiveInt(payload.max_attempts, config.workerRetryLimit + 1)
          const executionJob: WorkerExecutionJob = {
            ...payload,
            worker_id: workerId,
            timeout_ms: timeoutMs,
            ...(payload.cwd === undefined ? {} : { state_root: payload.cwd }),
          }
          const execute: Effect.Effect<WorkerExecutionOutcome, WorkerRunError> =
            payload.mode === "write-allowed" &&
              config.workerWriteIsolation === "worktree"
              ? runWithWorktreeIsolation(runner, executor, executionJob, config.workerWriteIsolation)
              : executor.run(executionJob).pipe(
                  Effect.map((result) => ({
                    result,
                    metadata: {
                      isolation: config.workerWriteIsolation,
                    },
                  })),
                )
          const attempt: Effect.Effect<WorkerRunType, WorkerRunError | EventStoreError> =
            runs.markRunning(workerId).pipe(
            Effect.zipRight(
              execute.pipe(
                Effect.timeoutFail({
                  duration: `${timeoutMs} millis`,
                  onTimeout: () =>
                    workerError(
                      "worker-supervisor.timeout",
                      `worker timed out after ${timeoutMs}ms`,
                      workerId,
                    ),
                }),
              ),
            ),
            Effect.flatMap(({ result, metadata }) =>
              runs.complete(workerId, result, undefined, metadata),
            ),
          )
          const isolatedAttempt =
            payload.mode === "write-allowed" && config.workerWriteIsolation === "serial"
              ? writeGate.withPermits(1)(attempt)
              : attempt

          return yield* isolatedAttempt.pipe(
            Effect.retry(workerRetrySchedule(maxAttempts - 1)),
            Effect.catchAll((cause) =>
              runs.fail(workerId, summarizeWorkerFailure(cause)).pipe(
                Effect.zipRight(Effect.fail(cause)),
              ),
            ),
          )
        })

      const completeQueueIfTerminal = (jobId: string, workerId: string) =>
        runs.get(workerId).pipe(
          Effect.flatMap((run) =>
            run !== null &&
              (run.status === "completed" || run.status === "failed" || run.status === "cancelled")
              ? queue.complete(jobId)
              : Effect.void,
          ),
        )

      const runJob = (job: WorkerJob): Effect.Effect<WorkerRunType, WorkerRunError | EventStoreError> =>
        decodePayload(job).pipe(
          Effect.flatMap((payload) => {
            const workerId = payload.worker_id ?? job.id
            return runDecoded(payload, workerId).pipe(
              Effect.either,
              Effect.flatMap((outcome) =>
                outcome._tag === "Right"
                  ? queue.complete(job.id).pipe(Effect.as(outcome.right))
                  : completeQueueIfTerminal(job.id, workerId).pipe(
                      Effect.zipRight(Effect.fail(outcome.left)),
                    ),
              ),
            )
          }),
        )

      const runOne: Effect.Effect<WorkerRunType, WorkerRunError | EventStoreError> = queue.take.pipe(
        Effect.flatMap(runJob),
      )

      return WorkerSupervisor.of({
        enqueue: (input) => {
          const workerId = input.worker_id ?? generatedWorkerId()
          const payload = { ...input, worker_id: workerId }
          return runs.get(workerId).pipe(
            Effect.flatMap((existing) => {
              if (existing !== null) {
                return payloadCompatibleWithRun(input, workerId, existing)
                  ? Effect.succeed(existing)
                  : Effect.fail(
                      workerError(
                        "worker-supervisor.enqueue",
                        "worker id already exists with incompatible payload",
                        workerId,
                      ),
                    )
              }
              return runs.createQueued({
                worker_id: workerId,
                session_id: input.session_id,
                ...(input.parent_task_id === undefined ? {} : { parent_task_id: input.parent_task_id }),
                ...(input.agent_id === undefined ? {} : { agent_id: input.agent_id }),
                agent_type: input.agent_type,
                mode: input.mode,
                prompt_hash: promptHashForPayload(input),
                scope: input.scope,
              }).pipe(
                Effect.flatMap((queued) =>
                  queue.offer(jobForPayload(payload, workerId)).pipe(
                    Effect.as(queued),
                    Effect.catchAll((cause) =>
                      runs
                        .cancel(workerId, `enqueue failed: ${summarizeWorkerFailure(cause)}`)
                        .pipe(
                          Effect.catchAll(() => Effect.void),
                          Effect.zipRight(
                            Effect.fail(
                              cause instanceof WorkerRunError
                                ? cause
                                : workerError("worker-supervisor.enqueue", cause.message, workerId, cause),
                            ),
                          ),
                        ),
                    ),
                  ),
                ),
              )
            }),
            Effect.mapError((cause) =>
              cause instanceof WorkerRunError
                ? cause
                : workerError("worker-supervisor.enqueue", cause.message, workerId, cause),
            ),
          )
        },
        runOne,
        runN: (count) =>
          Effect.gen(function* () {
            const config = yield* loadRuntimeConfig
            const runCount = Math.max(0, Math.floor(count))
            if (runCount === 0) return []
            const concurrency = Math.max(1, Math.min(runCount, config.workerMaxConcurrent))
            const completed: WorkerRunType[] = []
            while (completed.length < runCount) {
              const needed = Math.min(concurrency, runCount - completed.length)
              const maybeJobs = yield* Effect.forEach(
                Array.from({ length: needed }),
                () => queue.take.pipe(Effect.timeoutOption("100 millis")),
                { concurrency: needed },
              )
              const jobs = maybeJobs
                .filter(Option.isSome)
                .map((job) => job.value)
              if (jobs.length === 0) break
              const batch = yield* Effect.forEach(jobs, runJob, { concurrency })
              completed.push(...batch)
            }
            return completed
          }),
      })
    }),
  )
