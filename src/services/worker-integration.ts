import { Context, Effect, Layer } from "effect"
import * as path from "node:path"
import { EventStoreError, WorkerRunError } from "../schema/errors.ts"
import type { WorkerIntegrationApplyResult, WorkerRun } from "../schema/worker-run.ts"
import { CommandRunner } from "./command-runner.ts"
import { WorkerRuns } from "./worker-runs.ts"

export interface WorkerIntegrationApplyOptions {
  readonly checkOnly?: boolean
}

export interface WorkerIntegrationApi {
  readonly applyWorkerPatch: (
    workerId: string,
    opts?: WorkerIntegrationApplyOptions,
  ) => Effect.Effect<WorkerIntegrationApplyResult, WorkerRunError | EventStoreError>
}

export class WorkerIntegration extends Context.Tag("WorkerIntegration")<
  WorkerIntegration,
  WorkerIntegrationApi
>() {}

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

const summarizeCause = (cause: unknown): string => {
  if (cause instanceof WorkerRunError) return `${cause.op}: ${cause.message}`
  if (cause instanceof EventStoreError) return `${cause.op}: ${cause.message}`
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`.slice(0, 240)
  return String(cause).slice(0, 240)
}

const repoRootForPatch = (workerId: string, patchPath: string): Effect.Effect<string, WorkerRunError> => {
  if (!path.isAbsolute(patchPath)) {
    return Effect.fail(
      workerError(
        "worker-integration.patchPath",
        "worker patch path must be absolute",
        workerId,
      ),
    )
  }
  const resolvedPatchPath = path.resolve(patchPath)
  const marker = `${path.sep}.claude-hooks${path.sep}state${path.sep}workers${path.sep}patches${path.sep}`
  const index = resolvedPatchPath.lastIndexOf(marker)
  if (index <= 0) {
    return Effect.fail(
      workerError(
        "worker-integration.patchPath",
        "worker patch path is outside .claude-hooks/state/workers/patches",
        workerId,
      ),
    )
  }
  const repoRoot = resolvedPatchPath.slice(0, index)
  const patchRoot = path.join(repoRoot, ".claude-hooks", "state", "workers", "patches")
  const relative = path.relative(patchRoot, resolvedPatchPath)
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    return Effect.fail(
      workerError(
        "worker-integration.patchPath",
        "worker patch path escapes .claude-hooks/state/workers/patches",
        workerId,
      ),
    )
  }
  return Effect.succeed(repoRoot)
}

const validateRunForApply = (workerId: string, run: WorkerRun | null): Effect.Effect<WorkerRun, WorkerRunError> => {
  if (run === null) {
    return Effect.fail(workerError("worker-integration.apply", "worker run not found", workerId))
  }
  if (run.status !== "completed") {
    return Effect.fail(
      workerError("worker-integration.apply", `worker run is ${run.status}, not completed`, workerId),
    )
  }
  if (run.mode !== "write-allowed") {
    return Effect.fail(
      workerError("worker-integration.apply", "read-only worker output has no patch to apply", workerId),
    )
  }
  if (run.patch_path === undefined || run.patch_path.trim().length === 0) {
    return Effect.fail(
      workerError("worker-integration.apply", "worker completed without a captured patch", workerId),
    )
  }
  const result = run.result ?? run.output
  const failedVerification = result?.verification.find((check) => check.status !== "passed")
  if (failedVerification !== undefined) {
    return Effect.fail(
      workerError(
        "worker-integration.apply",
        `worker verification is not passed: ${failedVerification.check}=${failedVerification.status}`,
        workerId,
      ),
    )
  }
  if ((result?.verification.length ?? 0) === 0) {
    return Effect.fail(
      workerError("worker-integration.apply", "worker patch has no verification evidence", workerId),
    )
  }
  if ((result?.blockers.length ?? 0) > 0) {
    return Effect.fail(
      workerError("worker-integration.apply", "worker patch still has blockers", workerId),
    )
  }
  return Effect.succeed(run)
}

const runGitApply = (
  runner: CommandRunner["Type"],
  workerId: string,
  repoRoot: string,
  args: ReadonlyArray<string>,
): Effect.Effect<void, WorkerRunError> =>
  runner
    .run("git", args, {
      cwd: repoRoot,
      timeoutMs: 30_000,
      stdoutMaxBytes: 200_000,
      stderrMaxBytes: 200_000,
    })
    .pipe(
      Effect.flatMap((result) => {
        if (result.timedOut) {
          return Effect.fail(
            workerError("worker-integration.apply", `git ${args.join(" ")} timed out`, workerId, result),
          )
        }
        if (result.exitCode !== 0) {
          const detail = (result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} exited ${result.exitCode}`)
            .slice(0, 500)
          return Effect.fail(workerError("worker-integration.apply", detail, workerId, result))
        }
        return Effect.void
      }),
      Effect.mapError((cause) =>
        cause instanceof WorkerRunError
          ? cause
          : workerError("worker-integration.apply", String(cause), workerId, cause),
      ),
    )

const ensureCleanWorkspace = (
  runner: CommandRunner["Type"],
  workerId: string,
  repoRoot: string,
): Effect.Effect<void, WorkerRunError> =>
  runner
    .run("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      timeoutMs: 30_000,
      stdoutMaxBytes: 200_000,
      stderrMaxBytes: 200_000,
    })
    .pipe(
      Effect.flatMap((result) => {
        if (result.timedOut) {
          return Effect.fail(workerError("worker-integration.apply", "git status timed out", workerId, result))
        }
        if (result.exitCode !== 0) {
          const detail = (result.stderr.trim() || result.stdout.trim() || `git status exited ${result.exitCode}`)
            .slice(0, 500)
          return Effect.fail(workerError("worker-integration.apply", detail, workerId, result))
        }
        if (result.stdout.trim().length > 0) {
          return Effect.fail(
            workerError(
              "worker-integration.apply",
              "parent workspace has changes; apply worker patches from a clean workspace",
              workerId,
              result.stdout,
            ),
          )
        }
        return Effect.void
      }),
      Effect.mapError((cause) =>
        cause instanceof WorkerRunError
          ? cause
          : workerError("worker-integration.apply", String(cause), workerId, cause),
      ),
    )

const applyPatchAndMarkIntegrated = (
  runner: CommandRunner["Type"],
  runs: WorkerRuns["Type"],
  workerId: string,
  repoRoot: string,
  patchPath: string,
): Effect.Effect<void, WorkerRunError | EventStoreError> =>
  runGitApply(runner, workerId, repoRoot, ["apply", patchPath]).pipe(
    Effect.zipRight(
      runs.markIntegrated(workerId).pipe(
        Effect.catchAll((cause) =>
          runGitApply(runner, workerId, repoRoot, ["apply", "-R", patchPath]).pipe(
            Effect.catchAll((rollbackCause) =>
              Effect.fail(
                workerError(
                  "worker-integration.rollback",
                  `patch applied but integration state update failed and rollback failed: mark=${summarizeCause(cause)} rollback=${summarizeCause(rollbackCause)}`,
                  workerId,
                  { mark: cause, rollback: rollbackCause },
                ),
              ),
            ),
            Effect.zipRight(Effect.fail(cause)),
          ),
        ),
      ),
    ),
  )

export const WorkerIntegrationLive: Layer.Layer<
  WorkerIntegration,
  never,
  WorkerRuns | CommandRunner
> =
  Layer.effect(
    WorkerIntegration,
    Effect.gen(function* () {
      const runs = yield* WorkerRuns
      const runner = yield* CommandRunner
      return WorkerIntegration.of({
        applyWorkerPatch: (workerId, opts = {}) =>
          runs.get(workerId).pipe(
            Effect.flatMap((run) => validateRunForApply(workerId, run)),
            Effect.flatMap((run) =>
              run.integration_status === "applied"
                ? Effect.succeed({
                    worker_id: workerId,
                    patch_path: run.patch_path!,
                    applied: false,
                    check_only: opts.checkOnly === true,
                    final_verification_required: true,
                  })
                :
              repoRootForPatch(workerId, run.patch_path!).pipe(
                Effect.flatMap((repoRoot) =>
                  ensureCleanWorkspace(runner, workerId, repoRoot).pipe(
                    Effect.zipRight(runGitApply(runner, workerId, repoRoot, ["apply", "--check", run.patch_path!])),
                    Effect.zipRight(
                      opts.checkOnly === true
                        ? Effect.void
                        : applyPatchAndMarkIntegrated(runner, runs, workerId, repoRoot, run.patch_path!),
                    ),
                    Effect.as({
                      worker_id: workerId,
                      patch_path: run.patch_path!,
                      applied: opts.checkOnly !== true,
                      check_only: opts.checkOnly === true,
                      final_verification_required: true,
                    }),
                  ),
                ),
              ),
            ),
          ),
      })
    }),
  )
