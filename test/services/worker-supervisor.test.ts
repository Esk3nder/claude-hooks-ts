import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RuntimeConfigTest } from "../../src/services/runtime-config.ts"
import { EventStoreLive, EventStoreTest } from "../../src/services/event-store.ts"
import { CommandRunnerTest, type CommandRunResult } from "../../src/services/command-runner.ts"
import { WorkerQueue, WorkerQueueLive } from "../../src/services/worker-queue.ts"
import { WorkerRuns, WorkerRunsLive } from "../../src/services/worker-runs.ts"
import {
  WorkerExecutor,
  WorkerExecutorLive,
  WorkerExecutorTest,
  WorkerSupervisor,
  WorkerSupervisorLive,
  WorkerSupervisorLiveBase,
  type WorkerExecutionJob,
} from "../../src/services/worker-supervisor.ts"
import { ClaudeSubprocessTest, type ClaudeSpawnOptions } from "../../src/services/claude-subprocess.ts"
import type { WorkerResult } from "../../src/schema/worker-run.ts"
import { WorkerRunError } from "../../src/schema/errors.ts"
import {
  CURRENT_WORKER_CONTRACT_HASH,
  CURRENT_WORKER_CONTRACT_VERSION,
  appendWorkerContract,
} from "../../src/policies/worker-contract.ts"

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
  test("live executor stamps spawned workers with hook correlation env", async () => {
    let captured: ClaudeSpawnOptions | undefined
    const layer = Layer.provide(
      WorkerExecutorLive,
      ClaudeSubprocessTest((_args, opts) => {
        captured = opts
        return {
          stdout: JSON.stringify(result("spawned")),
          stderr: "",
          exitCode: 0,
          latencyMs: 1,
          timedOut: false,
        }
      }),
    )

    const parsed = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* WorkerExecutor
        return yield* executor.run({
          worker_id: "worker-env",
          session_id: "session-1",
          agent_id: "agent-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt: "Do work.",
          scope: "src/**",
          timeout_ms: 1000,
          state_root: "/repo",
        })
      }).pipe(Effect.provide(layer)),
    )

    expect((parsed as WorkerResult).summary).toBe("spawned")
    expect(captured?.env?.["CLAUDE_HOOKS_WORKER_ID"]).toBe("worker-env")
    expect(captured?.env?.["CLAUDE_HOOKS_SESSION_ID"]).toBe("session-1")
    expect(captured?.env?.["CLAUDE_HOOKS_WORKER_AGENT_ID"]).toBe("agent-1")
    expect(captured?.env?.["CLAUDE_HOOKS_STATE_ROOT"]).toBe("/repo")
  })

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

  test("enqueue persists contract metadata only when parsed from the prompt", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* WorkerSupervisor
        const runs = yield* WorkerRuns
        yield* supervisor.enqueue({
          worker_id: "worker-contracted",
          session_id: "session-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt: appendWorkerContract("Scope: src/**\nDo the worker task.", "executor"),
          scope: "src/**",
        })
        yield* supervisor.enqueue({
          worker_id: "worker-uncontracted",
          session_id: "session-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt: "Scope: test/**\nDo the worker task.",
          scope: "test/**",
        })
        return {
          contracted: yield* runs.get("worker-contracted"),
          uncontracted: yield* runs.get("worker-uncontracted"),
        }
      }).pipe(Effect.provide(layerFor())),
    )

    expect(outcome.contracted?.contract_version).toBe(CURRENT_WORKER_CONTRACT_VERSION)
    expect(outcome.contracted?.contract_hash).toBe(CURRENT_WORKER_CONTRACT_HASH)
    expect(outcome.uncontracted?.contract_version).toBeUndefined()
    expect(outcome.uncontracted?.contract_hash).toBeUndefined()
  })

  test("recovered queue jobs persist parsed contract metadata when ensuring a run", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const queue = yield* WorkerQueue
        const supervisor = yield* WorkerSupervisor
        const runs = yield* WorkerRuns
        yield* queue.offer({
          id: "worker-recovered-contract",
          queue: "default",
          payload: {
            worker_id: "worker-recovered-contract",
            session_id: "session-1",
            agent_type: "executor",
            mode: "write-allowed" as const,
            prompt: appendWorkerContract("Scope: src/**\nRecovered job.", "executor"),
            scope: "src/**",
          },
          enqueuedAt: Date.now(),
          attempts: 0,
        })
        yield* supervisor.runOne
        return yield* runs.get("worker-recovered-contract")
      }).pipe(Effect.provide(layerFor())),
    )

    expect(outcome?.contract_version).toBe(CURRENT_WORKER_CONTRACT_VERSION)
    expect(outcome?.contract_hash).toBe(CURRENT_WORKER_CONTRACT_HASH)
  })

  test("recovered redacted worker jobs fail without executing descriptor prompts", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-supervisor-"))
    let executorCalls = 0
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const queue = yield* WorkerQueue
          yield* queue.offer({
            id: "worker-redacted",
            queue: "default",
            payload: {
              worker_id: "worker-redacted",
              session_id: "session-1",
              agent_type: "executor",
              mode: "write-allowed" as const,
              prompt: "original prompt that must not persist",
              prompt_hash: "producer-hash",
              scope: "src/**",
            },
            enqueuedAt: Date.now(),
            attempts: 0,
          })
        }).pipe(
          Effect.provide(WorkerQueueLive(root)),
          Effect.provide(EventStoreLive),
          Effect.provide(RuntimeConfigTest({ workerRetryLimit: 0 })),
        ),
      )

      const layer = Layer.provideMerge(
        WorkerSupervisorLive,
        Layer.mergeAll(
          Layer.provideMerge(
            Layer.mergeAll(WorkerQueueLive(root), WorkerRunsLive(root)),
            Layer.mergeAll(EventStoreLive, RuntimeConfigTest({ workerRetryLimit: 0 })),
          ),
          WorkerExecutorTest(() => {
            executorCalls += 1
            return result()
          }),
          CommandRunnerTest(),
          RuntimeConfigTest({ workerRetryLimit: 0 }),
        ),
      )

      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const supervisor = yield* WorkerSupervisor
          const runs = yield* WorkerRuns
          const runOne = yield* Effect.either(supervisor.runOne)
          return {
            runOne,
            latest: yield* runs.get("worker-redacted"),
          }
        }).pipe(Effect.provide(layer)),
      )

      expect(outcome.runOne._tag).toBe("Left")
      expect(executorCalls).toBe(0)
      expect(outcome.latest?.status).toBe("failed")
      expect(outcome.latest?.prompt_hash).toBe("producer-hash")
      expect(outcome.latest?.failure_reason).toContain("prompt was redacted")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("disabled workers do not ack claimed queue jobs", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-supervisor-"))
    try {
      const layer = Layer.provideMerge(
        WorkerSupervisorLive,
        Layer.mergeAll(
          Layer.provideMerge(
            Layer.mergeAll(WorkerQueueLive(root), WorkerRunsLive(root)),
            Layer.mergeAll(EventStoreLive, RuntimeConfigTest({ workerRetryLimit: 0, workersEnabled: false })),
          ),
          WorkerExecutorTest(() => result()),
          CommandRunnerTest(),
          RuntimeConfigTest({ workerRetryLimit: 0, workersEnabled: false }),
        ),
      )
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const supervisor = yield* WorkerSupervisor
          const runs = yield* WorkerRuns
          yield* supervisor.enqueue({
            worker_id: "worker-disabled",
            session_id: "session-1",
            agent_type: "executor",
            mode: "write-allowed",
            prompt: "Do the worker task.",
            scope: "**/*",
          })
          const runOne = yield* Effect.either(supervisor.runOne)
          return {
            runOne,
            latest: yield* runs.get("worker-disabled"),
          }
        }).pipe(Effect.provide(layer)),
      )

      expect(outcome.runOne._tag).toBe("Left")
      expect(outcome.latest?.status).toBe("queued")
      const claims = readFileSync(join(root, ".claude-hooks", "state", "workers", "default.claims.jsonl"), "utf8")
      expect(claims).toContain("worker-disabled")
      expect(claims).not.toContain("completedAt")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("duplicate enqueue rejects incompatible payload without rewinding completion", async () => {
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
        const duplicate = yield* Effect.either(supervisor.enqueue({
          worker_id: "worker-1",
          session_id: "session-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt: "second",
          scope: "other/**",
        }))
        return {
          duplicate,
          latest: yield* runs.get("worker-1"),
        }
      }).pipe(Effect.provide(layerFor())),
    )

    expect(result.duplicate._tag).toBe("Left")
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

  test("runN waits for in-progress jobs instead of timing out the execution attempt", async () => {
    const slowExecutor: Layer.Layer<WorkerExecutor> = Layer.succeed(
      WorkerExecutor,
      WorkerExecutor.of({
        run: (job) =>
          Effect.sleep("75 millis").pipe(
            Effect.as(result(job.worker_id)),
          ),
      }),
    )

    const completed = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* WorkerSupervisor
        yield* supervisor.enqueue({
          worker_id: "worker-slow",
          session_id: "session-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt: "slow worker",
          scope: "**/*",
        })
        return yield* supervisor.runN(1)
      }).pipe(Effect.provide(layerFor(slowExecutor))),
    )

    expect(completed.map((run) => run.worker_id)).toEqual(["worker-slow"])
    expect(completed[0]?.status).toBe("completed")
  })

  test("runN drains available jobs without blocking forever for an exact count", async () => {
    const completed = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* WorkerSupervisor
        yield* supervisor.enqueue({
          worker_id: "worker-only",
          session_id: "session-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt: "only queued worker",
          scope: "**/*",
        })
        return yield* supervisor.runN(2)
      }).pipe(Effect.provide(layerFor())),
    )

    expect(completed.map((run) => run.worker_id)).toEqual(["worker-only"])
  })

  test("queued jobs without cwd execute from the supervisor root", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-root-"))
    let capturedJob: WorkerExecutionJob | undefined
    try {
      const layer = Layer.provideMerge(
        WorkerSupervisorLiveBase(root),
        Layer.mergeAll(
          Layer.provideMerge(
            Layer.mergeAll(WorkerQueueLive(root), WorkerRunsLive(root)),
            Layer.mergeAll(EventStoreLive, RuntimeConfigTest({ workerRetryLimit: 0 })),
          ),
          WorkerExecutorTest((job) => {
            capturedJob = job
            return result()
          }),
          CommandRunnerTest(),
          RuntimeConfigTest({ workerRetryLimit: 0 }),
        ),
      )

      const completed = await Effect.runPromise(
        Effect.gen(function* () {
          const queue = yield* WorkerQueue
          const supervisor = yield* WorkerSupervisor
          yield* queue.offer({
            id: "worker-recovered",
            queue: "default",
            enqueuedAt: Date.now(),
            attempts: 0,
            payload: {
              worker_id: "worker-recovered",
              session_id: "session-1",
              agent_type: "executor",
              mode: "write-allowed",
              prompt: "run from the queue root",
              scope: "src/**",
            },
          })
          return yield* supervisor.runOne
        }).pipe(Effect.provide(layer)),
      )

      expect(completed.status).toBe("completed")
      expect(capturedJob?.cwd).toBe(root)
      expect(capturedJob?.state_root).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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
      if (args.join(" ") === "diff --cached --name-only") {
        return commandResult(command, args, "src/a.ts\n")
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
    // P1-2: patches are attempt-versioned so a retry preserves the
    // prior attempt's file. First attempt of `worker-worktree` writes
    // to `worker-worktree.1.patch`.
    expect(completed.patch_path).toBe(join(root, ".claude-hooks", "state", "workers", "patches", "worker-worktree.1.patch"))
    expect(existsSync(completed.patch_path!)).toBe(true)
    expect(readFileSync(completed.patch_path!, "utf8")).toContain("diff --git")
    expect(createdWorktree).toContain("worker-worktree")
    expect(executorCwd).toBe(createdWorktree)
    expect(gitCommands).toContain("add -A")
    expect(gitCommands).toContain("diff --cached --binary")
  })

  // P1-2 regression: previously the patch path was
  // `<workerId>.patch`, so a retry overwrote attempt 1's file and the
  // audit trail was lost. After versioning, attempt 1 lands at
  // `<workerId>.1.patch` and attempt 2 at `<workerId>.2.patch`; both
  // files persist after a successful retry, and the run record's
  // `patch_path` points at the latest.
  test("retry preserves the prior attempt's patch under versioned paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-retry-patch-"))
    try {
      const commandLayer = CommandRunnerTest((command, args) => {
        if (command !== "git") return commandResult(command, args)
        if (args.join(" ") === "rev-parse --show-toplevel") {
          return commandResult(command, args, `${root}\n`)
        }
        if (args.join(" ") === "status --porcelain") {
          return commandResult(command, args, "")
        }
        if (args.slice(0, 3).join(" ") === "worktree add --detach") {
          return commandResult(command, args, "")
        }
        if (args.join(" ") === "add -A") {
          return commandResult(command, args, "")
        }
        if (args.join(" ") === "diff --cached --binary") {
          // Distinct patch content per attempt — proves attempt 1's
          // file is not overwritten by attempt 2.
          return commandResult(command, args, "diff --git a/src/a.ts b/src/a.ts\n")
        }
        if (args.join(" ") === "diff --cached --name-only") {
          return commandResult(command, args, "src/a.ts\n")
        }
        if (args.slice(0, 3).join(" ") === "worktree remove --force") {
          return commandResult(command, args, "")
        }
        return { ...commandResult(command, args), exitCode: 1, stderr: `unexpected git ${args.join(" ")}` }
      })
      // Executor succeeds both times, but attempt 1 returns a payload
      // that fails `decodeWorkerResult` inside `runs.complete`, forcing
      // a real retry after patch capture has already written to
      // `<workerId>.1.patch`. Attempt 2 returns a valid result.
      let attempts = 0
      const flakyExecutor: Layer.Layer<WorkerExecutor> = Layer.succeed(
        WorkerExecutor,
        WorkerExecutor.of({
          run: (_job) =>
            Effect.sync(() => {
              attempts++
              return attempts === 1
                ? ({ summary: "missing fields" } as unknown as WorkerResult)
                : result("retry-success")
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
                workerRetryLimit: 1,
                workerWriteIsolation: "worktree",
              }),
            ),
          ),
          flakyExecutor,
          commandLayer,
          RuntimeConfigTest({
            workerRetryLimit: 1,
            workerWriteIsolation: "worktree",
          }),
        ),
      )

      const completed = await Effect.runPromise(
        Effect.gen(function* () {
          const supervisor = yield* WorkerSupervisor
          yield* supervisor.enqueue({
            worker_id: "worker-retry",
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

      expect(attempts).toBe(2)
      expect(completed.status).toBe("completed")
      // Latest attempt's path is exposed on the run record.
      expect(completed.patch_path).toBe(
        join(root, ".claude-hooks", "state", "workers", "patches", "worker-retry.2.patch"),
      )
      // Attempt 1's file is preserved on disk — the regression
      // guarantee. Before the fix, both attempts wrote to the same
      // `worker-retry.patch` path and attempt 1's bytes were lost.
      expect(
        existsSync(
          join(root, ".claude-hooks", "state", "workers", "patches", "worker-retry.1.patch"),
        ),
      ).toBe(true)
      expect(
        existsSync(
          join(root, ".claude-hooks", "state", "workers", "patches", "worker-retry.2.patch"),
        ),
      ).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // C-FU2 (review follow-up): complements the post-capture retry case
  // above. Here attempt 1's *executor* fails before patch capture
  // runs, so no `.1.patch` is ever written. Attempt 2 succeeds and
  // writes `.2.patch`. Proves that versioned naming gives the right
  // result regardless of *where* attempt 1 fails — the run record
  // points at `.2.patch` and `.1.patch` is correctly absent.
  test("retry where executor fails before capture writes only the successful attempt's patch", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-retry-noattempt1-"))
    try {
      const commandLayer = CommandRunnerTest((command, args) => {
        if (command !== "git") return commandResult(command, args)
        if (args.join(" ") === "rev-parse --show-toplevel") {
          return commandResult(command, args, `${root}\n`)
        }
        if (args.join(" ") === "status --porcelain") {
          return commandResult(command, args, "")
        }
        if (args.slice(0, 3).join(" ") === "worktree add --detach") {
          return commandResult(command, args, "")
        }
        if (args.join(" ") === "add -A") {
          return commandResult(command, args, "")
        }
        if (args.join(" ") === "diff --cached --binary") {
          return commandResult(command, args, "diff --git a/src/a.ts b/src/a.ts\n")
        }
        if (args.join(" ") === "diff --cached --name-only") {
          return commandResult(command, args, "src/a.ts\n")
        }
        if (args.slice(0, 3).join(" ") === "worktree remove --force") {
          return commandResult(command, args, "")
        }
        return { ...commandResult(command, args), exitCode: 1, stderr: `unexpected git ${args.join(" ")}` }
      })
      let attempts = 0
      // Attempt 1's executor fails BEFORE patch capture (the failure
      // short-circuits `runWithWorktreeIsolation`'s `Effect.gen`, so
      // none of the `git add -A` / `diff` / `writeWorkerPatch` steps
      // run for attempt 1). Attempt 2 succeeds and produces a normal
      // capture chain.
      const flakyExecutor: Layer.Layer<WorkerExecutor> = Layer.succeed(
        WorkerExecutor,
        WorkerExecutor.of({
          run: (job) =>
            Effect.suspend(() => {
              attempts++
              if (attempts === 1) {
                return Effect.fail(
                  new WorkerRunError({
                    op: "test.executor.attempt1",
                    workerId: job.worker_id,
                    message: "simulated executor failure on attempt 1",
                  }),
                )
              }
              return Effect.sync(() => result("retry-success-no-attempt1"))
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
                workerRetryLimit: 1,
                workerWriteIsolation: "worktree",
              }),
            ),
          ),
          flakyExecutor,
          commandLayer,
          RuntimeConfigTest({
            workerRetryLimit: 1,
            workerWriteIsolation: "worktree",
          }),
        ),
      )

      const completed = await Effect.runPromise(
        Effect.gen(function* () {
          const supervisor = yield* WorkerSupervisor
          yield* supervisor.enqueue({
            worker_id: "worker-retry-noattempt1",
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

      expect(attempts).toBe(2)
      expect(completed.status).toBe("completed")
      expect(completed.patch_path).toBe(
        join(
          root,
          ".claude-hooks",
          "state",
          "workers",
          "patches",
          "worker-retry-noattempt1.2.patch",
        ),
      )
      // `.1.patch` was never written because the executor failed
      // before patch capture. This is the complement of the existing
      // post-capture-retry test (which produces both `.1.patch` and
      // `.2.patch`).
      expect(
        existsSync(
          join(
            root,
            ".claude-hooks",
            "state",
            "workers",
            "patches",
            "worker-retry-noattempt1.1.patch",
          ),
        ),
      ).toBe(false)
      expect(
        existsSync(
          join(
            root,
            ".claude-hooks",
            "state",
            "workers",
            "patches",
            "worker-retry-noattempt1.2.patch",
          ),
        ),
      ).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // P0-4: write-allowed + serial isolation now captures a parent-cwd
  // patch via `git stash create` before/after the worker. Pre-fix,
  // this branch produced no `patch_path` for the default-install
  // deployment, leaving worker writes unaudited.
  test("serial isolation captures a patch via stash-create snapshots", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-serial-"))
    const afterStash = "2222222222222222222222222222222222222222"
    const gitCommands: string[] = []
    let stashCreateCalls = 0
    let executorRanAt: "before-after-snapshots" | undefined
    try {
      const commandLayer = CommandRunnerTest((command, args) => {
        if (command !== "git") return commandResult(command, args)
        gitCommands.push(args.join(" "))
        if (args.join(" ") === "rev-parse --show-toplevel") {
          return commandResult(command, args, `${root}\n`)
        }
        if (args.join(" ") === "stash create") {
          stashCreateCalls += 1
          if (stashCreateCalls === 1) return commandResult(command, args, "")
          return commandResult(command, args, `${afterStash}\n`)
        }
        if (args[0] === "diff" && args.includes("--binary")) {
          return commandResult(command, args, "diff --git a/src/a.ts b/src/a.ts\n")
        }
        if (args[0] === "diff" && args.includes("--name-only")) {
          return commandResult(command, args, "src/a.ts\n")
        }
        return { ...commandResult(command, args), exitCode: 1, stderr: `unexpected git ${args.join(" ")}` }
      })
      const executorLayer: Layer.Layer<WorkerExecutor> = Layer.succeed(
        WorkerExecutor,
        WorkerExecutor.of({
          run: (_job) =>
            Effect.sync(() => {
              if (stashCreateCalls === 1) {
                executorRanAt = "before-after-snapshots"
              }
              return result("serial-isolated")
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
                workerWriteIsolation: "serial",
              }),
            ),
          ),
          executorLayer,
          commandLayer,
          RuntimeConfigTest({
            workerRetryLimit: 0,
            workerWriteIsolation: "serial",
          }),
        ),
      )

      const completed = await Effect.runPromise(
        Effect.gen(function* () {
          const supervisor = yield* WorkerSupervisor
          yield* supervisor.enqueue({
            worker_id: "worker-serial",
            session_id: "session-1",
            agent_type: "executor",
            mode: "write-allowed",
            prompt: "edit in parent cwd",
            scope: "src/**",
            cwd: root,
          })
          return yield* supervisor.runOne
        }).pipe(Effect.provide(layer)),
      )

      expect(completed.status).toBe("completed")
      expect(completed.isolation).toBe("serial")
      expect(completed.patch_path).toBe(
        join(
          root,
          ".claude-hooks",
          "state",
          "workers",
          "patches",
          "worker-serial.1.patch",
        ),
      )
      expect(existsSync(completed.patch_path!)).toBe(true)
      expect(readFileSync(completed.patch_path!, "utf8")).toContain("diff --git")
      expect(completed.patch_changed_files).toEqual(["src/a.ts"])
      expect(executorRanAt).toBe("before-after-snapshots")
      expect(stashCreateCalls).toBe(2)
      // BEFORE returned empty → baseline falls back to HEAD.
      expect(gitCommands).toContain(
        `diff --no-renames --binary HEAD ${afterStash}`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // P0-4 complement: when the BEFORE snapshot also returns a stash
  // sha (the parent cwd had pre-existing tracked changes), the diff
  // is between the two stash refs — not against HEAD — so the
  // captured patch is the worker's net contribution rather than the
  // parent's accumulated dirt.
  test("serial isolation diffs between stash refs when the tree was dirty before the worker", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-serial-dirty-"))
    const beforeStash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const afterStash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    const gitCommands: string[] = []
    let stashCreateCalls = 0
    try {
      const commandLayer = CommandRunnerTest((command, args) => {
        if (command !== "git") return commandResult(command, args)
        gitCommands.push(args.join(" "))
        if (args.join(" ") === "rev-parse --show-toplevel") {
          return commandResult(command, args, `${root}\n`)
        }
        if (args.join(" ") === "stash create") {
          stashCreateCalls += 1
          return commandResult(
            command,
            args,
            stashCreateCalls === 1 ? `${beforeStash}\n` : `${afterStash}\n`,
          )
        }
        if (args[0] === "diff" && args.includes("--binary")) {
          return commandResult(command, args, "diff --git a/src/b.ts b/src/b.ts\n")
        }
        if (args[0] === "diff" && args.includes("--name-only")) {
          return commandResult(command, args, "src/b.ts\n")
        }
        return { ...commandResult(command, args), exitCode: 1, stderr: `unexpected git ${args.join(" ")}` }
      })
      const executorLayer: Layer.Layer<WorkerExecutor> = Layer.succeed(
        WorkerExecutor,
        WorkerExecutor.of({
          run: (_job) => Effect.sync(() => result("serial-dirty")),
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
                workerWriteIsolation: "serial",
              }),
            ),
          ),
          executorLayer,
          commandLayer,
          RuntimeConfigTest({
            workerRetryLimit: 0,
            workerWriteIsolation: "serial",
          }),
        ),
      )

      const completed = await Effect.runPromise(
        Effect.gen(function* () {
          const supervisor = yield* WorkerSupervisor
          yield* supervisor.enqueue({
            worker_id: "worker-serial-dirty",
            session_id: "session-1",
            agent_type: "executor",
            mode: "write-allowed",
            prompt: "edit in dirty parent cwd",
            scope: "src/**",
            cwd: root,
          })
          return yield* supervisor.runOne
        }).pipe(Effect.provide(layer)),
      )

      expect(completed.status).toBe("completed")
      expect(gitCommands).toContain(
        `diff --no-renames --binary ${beforeStash} ${afterStash}`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // P0-4 negative case: when both stash-creates return empty (tree
  // unchanged), no diff command runs and no patch_path is set.
  test("serial isolation produces no patch when the tree was untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-serial-clean-"))
    const gitCommands: string[] = []
    try {
      const commandLayer = CommandRunnerTest((command, args) => {
        if (command !== "git") return commandResult(command, args)
        gitCommands.push(args.join(" "))
        if (args.join(" ") === "rev-parse --show-toplevel") {
          return commandResult(command, args, `${root}\n`)
        }
        if (args.join(" ") === "stash create") {
          return commandResult(command, args, "")
        }
        return { ...commandResult(command, args), exitCode: 1, stderr: `unexpected git ${args.join(" ")}` }
      })
      const executorLayer: Layer.Layer<WorkerExecutor> = Layer.succeed(
        WorkerExecutor,
        WorkerExecutor.of({
          run: (_job) => Effect.sync(() => result("serial-noop")),
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
                workerWriteIsolation: "serial",
              }),
            ),
          ),
          executorLayer,
          commandLayer,
          RuntimeConfigTest({
            workerRetryLimit: 0,
            workerWriteIsolation: "serial",
          }),
        ),
      )

      const completed = await Effect.runPromise(
        Effect.gen(function* () {
          const supervisor = yield* WorkerSupervisor
          yield* supervisor.enqueue({
            worker_id: "worker-serial-clean",
            session_id: "session-1",
            agent_type: "executor",
            mode: "write-allowed",
            prompt: "no edits",
            scope: "src/**",
            cwd: root,
          })
          return yield* supervisor.runOne
        }).pipe(Effect.provide(layer)),
      )

      expect(completed.status).toBe("completed")
      expect(completed.isolation).toBe("serial")
      expect(completed.patch_path).toBeUndefined()
      expect(completed.patch_changed_files).toBeUndefined()
      expect(gitCommands.some((c) => c.startsWith("diff "))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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
