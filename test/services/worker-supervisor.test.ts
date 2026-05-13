import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RuntimeConfigTest } from "../../src/services/runtime-config.ts"
import { EventStoreTest } from "../../src/services/event-store.ts"
import { CommandRunnerTest, type CommandRunResult } from "../../src/services/command-runner.ts"
import { WorkerQueueLive } from "../../src/services/worker-queue.ts"
import { WorkerRuns, WorkerRunsLive } from "../../src/services/worker-runs.ts"
import {
  WorkerExecutor,
  WorkerExecutorTest,
  WorkerSupervisor,
  WorkerSupervisorLive,
} from "../../src/services/worker-supervisor.ts"
import type { WorkerResult } from "../../src/schema/worker-run.ts"

const result = (summary = "supervisor result"): WorkerResult => ({
  summary,
  files_relevant: [],
  changes_made: [],
  commands_run: [],
  verification: [
    {
      check: "worker supervisor",
      status: "passed",
      evidence: "executor returned structured output",
    },
  ],
  risks: [],
  blockers: [],
  confidence: "high",
})

const commandResult = (
  command: string,
  args: ReadonlyArray<string>,
  stdout = "",
): CommandRunResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
  timedOut: false,
  durationMs: 0,
  commandPreview: [command, ...args].join(" "),
})

const layerFor = (executor = WorkerExecutorTest(() => result())) =>
  Layer.provideMerge(
    WorkerSupervisorLive,
    Layer.mergeAll(
      Layer.provideMerge(
        Layer.mergeAll(WorkerQueueLive(), WorkerRunsLive()),
        Layer.mergeAll(EventStoreTest(), RuntimeConfigTest({ workerRetryLimit: 0 })),
      ),
      executor,
      CommandRunnerTest(),
      RuntimeConfigTest({ workerRetryLimit: 0 }),
    ),
  )

describe("WorkerSupervisorLive", () => {
  test("enqueue → runOne records queued, running, and completed typed result", async () => {
    const completed = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* WorkerSupervisor
        const runs = yield* WorkerRuns
        yield* supervisor.enqueue({
          worker_id: "worker-1",
          session_id: "session-1",
          agent_id: "agent-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt: "Scope: src/services/**\nDo the worker task.",
          scope: "src/services/**",
        })
        yield* supervisor.runOne
        return yield* runs.get("worker-1")
      }).pipe(Effect.provide(layerFor())),
    )

    expect(completed?.status).toBe("completed")
    expect(completed?.attempts).toBe(1)
    expect(completed?.prompt_hash).toHaveLength(16)
    expect(completed?.output?.summary).toBe("supervisor result")
  })

  test("duplicate enqueue returns the existing run without rewinding completion", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* WorkerSupervisor
        const runs = yield* WorkerRuns
        yield* supervisor.enqueue({
          worker_id: "worker-1",
          session_id: "session-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt: "first",
          scope: "src/**",
        })
        yield* supervisor.runOne
        const duplicate = yield* supervisor.enqueue({
          worker_id: "worker-1",
          session_id: "session-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt: "second",
          scope: "other/**",
        })
        return {
          duplicate,
          latest: yield* runs.get("worker-1"),
        }
      }).pipe(Effect.provide(layerFor())),
    )

    expect(result.duplicate.status).toBe("completed")
    expect(result.latest?.status).toBe("completed")
    expect(result.latest?.scope).toBe("src/**")
    expect(result.latest?.output?.summary).toBe("supervisor result")
  })

  test("malformed worker result marks the run failed", async () => {
    const latest = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* WorkerSupervisor
        const runs = yield* WorkerRuns
        yield* supervisor.enqueue({
          worker_id: "worker-1",
          session_id: "session-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt: "Do the worker task.",
          scope: "**/*",
        })
        const exit = yield* supervisor.runOne.pipe(Effect.either)
        expect(exit._tag).toBe("Left")
        return yield* runs.get("worker-1")
      }).pipe(Effect.provide(layerFor(WorkerExecutorTest(() => ({ summary: "bad" }))))),
    )

    expect(latest?.status).toBe("failed")
    expect(latest?.failure_reason).toContain("worker result schema decode failed")
  })

  test("timeout failures become failed worker runs", async () => {
    const neverExecutor: Layer.Layer<WorkerExecutor> = Layer.succeed(
      WorkerExecutor,
      WorkerExecutor.of({
        run: () => Effect.never,
      }),
    )
    const layer = Layer.provideMerge(
      WorkerSupervisorLive,
      Layer.mergeAll(
        Layer.provideMerge(
          Layer.mergeAll(WorkerQueueLive(), WorkerRunsLive()),
          Layer.mergeAll(EventStoreTest(), RuntimeConfigTest({ workerRetryLimit: 0 })),
        ),
        neverExecutor,
        CommandRunnerTest(),
        RuntimeConfigTest({ workerRetryLimit: 0 }),
      ),
    )

    const latest = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* WorkerSupervisor
        const runs = yield* WorkerRuns
        yield* supervisor.enqueue({
          worker_id: "worker-timeout",
          session_id: "session-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt: "Do the worker task.",
          scope: "**/*",
          timeout_ms: 5,
        })
        yield* supervisor.runOne.pipe(Effect.either)
        return yield* runs.get("worker-timeout")
      }).pipe(Effect.provide(layer)),
    )

    expect(latest?.status).toBe("failed")
    expect(latest?.failure_reason).toContain("timed out")
  })

  test("runN honors serial isolation for write workers", async () => {
    let active = 0
    let maxActive = 0
    const trackingExecutor: Layer.Layer<WorkerExecutor> = Layer.succeed(
      WorkerExecutor,
      WorkerExecutor.of({
        run: (job) =>
          Effect.gen(function* () {
            active += 1
            maxActive = Math.max(maxActive, active)
            yield* Effect.sleep("10 millis")
            active -= 1
            return result(job.worker_id)
          }),
      }),
    )
    const layer = Layer.provideMerge(
      WorkerSupervisorLive,
      Layer.mergeAll(
        Layer.provideMerge(
          Layer.mergeAll(WorkerQueueLive(), WorkerRunsLive()),
          Layer.mergeAll(
            EventStoreTest(),
            RuntimeConfigTest({
              workerMaxConcurrent: 2,
              workerRetryLimit: 0,
              workerWriteIsolation: "serial",
            }),
          ),
        ),
        trackingExecutor,
        CommandRunnerTest(),
        RuntimeConfigTest({
          workerMaxConcurrent: 2,
          workerRetryLimit: 0,
          workerWriteIsolation: "serial",
        }),
      ),
    )

    const completed = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* WorkerSupervisor
        yield* supervisor.enqueue({
          worker_id: "worker-1",
          session_id: "session-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt: "first",
          scope: "**/*",
        })
        yield* supervisor.enqueue({
          worker_id: "worker-2",
          session_id: "session-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt: "second",
          scope: "**/*",
        })
        return yield* supervisor.runN(2)
      }).pipe(Effect.provide(layer)),
    )

    expect(completed.map((run) => run.status)).toEqual(["completed", "completed"])
    expect(maxActive).toBe(1)
  })

  test("worktree isolation runs write workers in a temporary worktree and captures a patch", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-worktree-"))
    let executorCwd = ""
    let createdWorktree = ""
    const gitCommands: string[] = []
    const commandLayer = CommandRunnerTest((command, args) => {
      if (command === "git") gitCommands.push(args.join(" "))
      if (command !== "git") return commandResult(command, args)
      if (args.join(" ") === "rev-parse --show-toplevel") {
        return commandResult(command, args, `${root}\n`)
      }
      if (args.join(" ") === "status --porcelain") {
        return commandResult(command, args, "")
      }
      if (args.slice(0, 3).join(" ") === "worktree add --detach") {
        createdWorktree = args[3] ?? ""
        return commandResult(command, args, "")
      }
      if (args.join(" ") === "add -A") {
        return commandResult(command, args, "")
      }
      if (args.join(" ") === "diff --cached --binary") {
        return commandResult(command, args, "diff --git a/src/a.ts b/src/a.ts\n")
      }
      if (args.slice(0, 3).join(" ") === "worktree remove --force") {
        return commandResult(command, args, "")
      }
      return { ...commandResult(command, args), exitCode: 1, stderr: `unexpected git ${args.join(" ")}` }
    })
    const executorLayer: Layer.Layer<WorkerExecutor> = Layer.succeed(
      WorkerExecutor,
      WorkerExecutor.of({
        run: (job) =>
          Effect.sync(() => {
            executorCwd = job.cwd ?? ""
            return result("isolated")
          }),
      }),
    )
    const layer = Layer.provideMerge(
      WorkerSupervisorLive,
      Layer.mergeAll(
        Layer.provideMerge(
          Layer.mergeAll(WorkerQueueLive(), WorkerRunsLive()),
          Layer.mergeAll(
            EventStoreTest(),
            RuntimeConfigTest({
              workerRetryLimit: 0,
              workerWriteIsolation: "worktree",
            }),
          ),
        ),
        executorLayer,
        commandLayer,
        RuntimeConfigTest({
          workerRetryLimit: 0,
          workerWriteIsolation: "worktree",
        }),
      ),
    )

    const completed = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* WorkerSupervisor
        yield* supervisor.enqueue({
          worker_id: "worker-worktree",
          session_id: "session-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt: "edit in isolation",
          scope: "src/**",
          cwd: root,
        })
        return yield* supervisor.runOne
      }).pipe(Effect.provide(layer)),
    )

    expect(completed.status).toBe("completed")
    expect(completed.isolation).toBe("worktree")
    expect(completed.patch_path).toBe(join(root, ".claude-hooks", "state", "workers", "patches", "worker-worktree.patch"))
    expect(existsSync(completed.patch_path!)).toBe(true)
    expect(readFileSync(completed.patch_path!, "utf8")).toContain("diff --git")
    expect(createdWorktree).toContain("worker-worktree")
    expect(executorCwd).toBe(createdWorktree)
    expect(gitCommands).toContain("add -A")
    expect(gitCommands).toContain("diff --cached --binary")
  })

  test("worktree isolation fails explicitly when the source worktree is dirty", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-dirty-"))
    const commandLayer = CommandRunnerTest((command, args) => {
      if (command !== "git") return commandResult(command, args)
      if (args.join(" ") === "rev-parse --show-toplevel") {
        return commandResult(command, args, `${root}\n`)
      }
      if (args.join(" ") === "status --porcelain") {
        return commandResult(command, args, " M src/a.ts\n")
      }
      return commandResult(command, args)
    })
    const layer = Layer.provideMerge(
      WorkerSupervisorLive,
      Layer.mergeAll(
        Layer.provideMerge(
          Layer.mergeAll(WorkerQueueLive(), WorkerRunsLive()),
          Layer.mergeAll(
            EventStoreTest(),
            RuntimeConfigTest({
              workerRetryLimit: 0,
              workerWriteIsolation: "worktree",
            }),
          ),
        ),
        WorkerExecutorTest(() => result("should not run")),
        commandLayer,
        RuntimeConfigTest({
          workerRetryLimit: 0,
          workerWriteIsolation: "worktree",
        }),
      ),
    )

    const latest = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* WorkerSupervisor
        const runs = yield* WorkerRuns
        yield* supervisor.enqueue({
          worker_id: "worker-dirty",
          session_id: "session-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt: "edit in isolation",
          scope: "src/**",
          cwd: root,
        })
        yield* supervisor.runOne.pipe(Effect.either)
        return yield* runs.get("worker-dirty")
      }).pipe(Effect.provide(layer)),
    )

    expect(latest?.status).toBe("failed")
    expect(latest?.failure_reason).toContain("requires a clean source worktree")
  })

  test("enqueue failure cancels the created run instead of leaving it active", async () => {
    const layer = Layer.provideMerge(
      WorkerSupervisorLive,
      Layer.mergeAll(
        Layer.provideMerge(
          Layer.mergeAll(WorkerQueueLive(undefined, "default", 1), WorkerRunsLive()),
          Layer.mergeAll(EventStoreTest(), RuntimeConfigTest({ workerRetryLimit: 0 })),
        ),
        WorkerExecutorTest(() => result()),
        CommandRunnerTest(),
        RuntimeConfigTest({ workerRetryLimit: 0 }),
      ),
    )

    const latest = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* WorkerSupervisor
        const runs = yield* WorkerRuns
        yield* supervisor.enqueue({
          worker_id: "worker-queued",
          session_id: "session-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt: "first",
          scope: "**/*",
        })
        yield* supervisor.enqueue({
          worker_id: "worker-rejected",
          session_id: "session-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt: "second",
          scope: "**/*",
        }).pipe(Effect.either)
        return yield* runs.get("worker-rejected")
      }).pipe(Effect.provide(layer)),
    )

    expect(latest?.status).toBe("cancelled")
    expect(latest?.failure_reason).toContain("enqueue failed")
  })
})
