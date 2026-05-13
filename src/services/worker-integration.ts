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

const repoRootForPatch = (workerId: string, patchPath: string): Effect.Effect<string, WorkerRunError> => {
  const marker = `${path.sep}.claude-hooks${path.sep}state${path.sep}workers${path.sep}patches${path.sep}`
  const index = patchPath.indexOf(marker)
  if (index <= 0) {
    return Effect.fail(
      workerError(
        "worker-integration.patchPath",
        "worker patch path is outside .claude-hooks/state/workers/patches",
        workerId,
      ),
    )
  }
  return Effect.succeed(patchPath.slice(0, index))
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
              repoRootForPatch(workerId, run.patch_path!).pipe(
                Effect.flatMap((repoRoot) =>
                  runGitApply(runner, workerId, repoRoot, ["apply", "--check", run.patch_path!]).pipe(
                    Effect.zipRight(
                      opts.checkOnly === true
                        ? Effect.void
                        : runGitApply(runner, workerId, repoRoot, ["apply", run.patch_path!]).pipe(
                            Effect.zipRight(runs.markIntegrated(workerId)),
                          ),
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
