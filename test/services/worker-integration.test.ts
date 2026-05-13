import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CommandRunner,
  CommandRunnerTest,
  type CommandRunResult,
} from "../../src/services/command-runner.ts"
import { EventStoreTest } from "../../src/services/event-store.ts"
import { WorkerIntegration, WorkerIntegrationLive } from "../../src/services/worker-integration.ts"
import { WorkerRuns, WorkerRunsLive } from "../../src/services/worker-runs.ts"
import type { WorkerResult } from "../../src/schema/worker-run.ts"

const commandResult = (
  command: string,
  args: ReadonlyArray<string>,
  exitCode = 0,
  stderr = "",
): CommandRunResult => ({
  stdout: "",
  stderr,
  exitCode,
  timedOut: false,
  durationMs: 0,
  commandPreview: [command, ...args].join(" "),
})

const result = (status: "passed" | "failed" | "not_run" = "passed"): WorkerResult => ({
  summary: "worker done",
  files_relevant: [],
  changes_made: [{ path: "src/a.ts", summary: "changed" }],
  commands_run: [],
  verification: [{ check: "unit", status, evidence: status }],
  risks: [],
  blockers: [],
  confidence: "high",
})

const seedCompleted = (root: string, verification: "passed" | "failed" | "not_run" = "passed") =>
  Effect.gen(function* () {
    const runs = yield* WorkerRuns
    yield* runs.createQueued({
      worker_id: "worker-1",
      session_id: "session-1",
      agent_type: "executor",
      mode: "write-allowed",
      prompt_hash: "prompt-hash",
      scope: "src/**",
    })
    return yield* runs.complete("worker-1", result(verification), undefined, {
      isolation: "worktree",
      patch_path: join(root, ".claude-hooks", "state", "workers", "patches", "worker-1.patch"),
    })
  })

const layerFor = (root: string, commandLayer: Layer.Layer<CommandRunner>) =>
  Layer.provideMerge(
    WorkerIntegrationLive,
    Layer.mergeAll(
      Layer.provide(WorkerRunsLive(root), EventStoreTest()),
      commandLayer,
    ),
  )

describe("WorkerIntegrationLive", () => {
  test("checks and applies a completed verified worker patch", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-apply-"))
    const commands: string[] = []
    const layer = layerFor(
      root,
      CommandRunnerTest((command, args) => {
        commands.push([command, ...args].join(" "))
        return commandResult(command, args)
      }),
    )

    const applied = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedCompleted(root)
        const integration = yield* WorkerIntegration
        const result = yield* integration.applyWorkerPatch("worker-1")
        const runs = yield* WorkerRuns
        const latest = yield* runs.get("worker-1")
        return { result, latest }
      }).pipe(Effect.provide(layer)),
    )

    expect(applied.result.applied).toBe(true)
    expect(applied.result.final_verification_required).toBe(true)
    expect(applied.latest?.integration_status).toBe("applied")
    expect(commands).toEqual([
      `git apply --check ${applied.result.patch_path}`,
      `git apply ${applied.result.patch_path}`,
    ])
  })

  test("check-only mode never applies the patch", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-check-"))
    const commands: string[] = []
    const layer = layerFor(
      root,
      CommandRunnerTest((command, args) => {
        commands.push([command, ...args].join(" "))
        return commandResult(command, args)
      }),
    )

    const checked = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedCompleted(root)
        const integration = yield* WorkerIntegration
        return yield* integration.applyWorkerPatch("worker-1", { checkOnly: true })
      }).pipe(Effect.provide(layer)),
    )

    expect(checked.applied).toBe(false)
    expect(commands).toEqual([`git apply --check ${checked.patch_path}`])
  })

  test("failed verification blocks patch application", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-deny-"))
    const commands: string[] = []
    const layer = layerFor(
      root,
      CommandRunnerTest((command, args) => {
        commands.push([command, ...args].join(" "))
        return commandResult(command, args)
      }),
    )

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedCompleted(root, "failed")
        const integration = yield* WorkerIntegration
        return yield* integration.applyWorkerPatch("worker-1").pipe(Effect.either)
      }).pipe(Effect.provide(layer)),
    )

    expect(exit._tag).toBe("Left")
    expect(commands).toEqual([])
  })

  test("git apply check failure is surfaced before apply", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-conflict-"))
    const commands: string[] = []
    const layer = layerFor(
      root,
      CommandRunnerTest((command, args) => {
        commands.push([command, ...args].join(" "))
        return commandResult(command, args, 1, "patch does not apply")
      }),
    )

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedCompleted(root)
        const integration = yield* WorkerIntegration
        return yield* integration.applyWorkerPatch("worker-1").pipe(Effect.either)
      }).pipe(Effect.provide(layer)),
    )

    expect(exit._tag).toBe("Left")
    expect(commands).toEqual([
      `git apply --check ${join(root, ".claude-hooks", "state", "workers", "patches", "worker-1.patch")}`,
    ])
  })
})
