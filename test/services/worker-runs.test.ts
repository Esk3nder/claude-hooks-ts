import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppTest } from "../../src/layers/test.ts"
import { type WorkerResult } from "../../src/schema/worker-run.ts"
import { EventStoreLive } from "../../src/services/event-store.ts"
import { WorkerQueue } from "../../src/services/worker-queue.ts"
import { hashWorkerPrompt, WorkerRuns, WorkerRunsLive } from "../../src/services/worker-runs.ts"

const validResult = (summary = "worker finished"): WorkerResult => ({
  summary,
  files_relevant: [
    {
      path: "src/services/worker-runs.ts",
      reason: "owns worker lifecycle state",
    },
  ],
  changes_made: [
    {
      path: "src/services/worker-runs.ts",
      summary: "recorded lifecycle transitions",
    },
  ],
  commands_run: [
    {
      command: "bun test test/services/worker-runs.test.ts",
      exit_code: 0,
      result: "passed",
    },
  ],
  verification: [
    {
      check: "worker run lifecycle",
      status: "passed",
      evidence: "typed result decoded and persisted",
    },
  ],
  risks: [],
  blockers: [],
  confidence: "high",
})

describe("WorkerRunsLive", () => {
  test("persists prompt hashes without raw prompts", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-runs-"))
    try {
      const prompt = "raw prompt content must not persist"
      const run = await Effect.runPromise(
        Effect.gen(function* () {
          const runs = yield* WorkerRuns
          return yield* runs.createQueued({
            worker_id: "worker-1",
            session_id: "session-1",
            agent_type: "Explore",
            mode: "read-only",
            prompt,
            scope: "src/**",
            created_at: "2026-05-13T00:00:00.000Z",
          })
        }).pipe(Effect.provide(WorkerRunsLive(root)), Effect.provide(EventStoreLive)),
      )

      const persisted = readFileSync(
        join(root, ".claude-hooks", "state", "workers", "runs.jsonl"),
        "utf8",
      )
      expect(run.prompt_hash).toBe(hashWorkerPrompt(prompt))
      expect(persisted).toContain("worker-1")
      expect(persisted).toContain(run.prompt_hash)
      expect(persisted).not.toContain(prompt)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("records running and completed snapshots with typed output aliases and integration state", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-runs-"))
    try {
      const latest = await Effect.runPromise(
        Effect.gen(function* () {
          const runs = yield* WorkerRuns
          yield* runs.createQueued({
            worker_id: "worker-1",
            session_id: "session-1",
            agent_id: "agent-1",
            agent_type: "executor",
            mode: "write-allowed",
            prompt_hash: "prompt-hash-1",
            scope: "src/services/worker-runs.ts",
            created_at: "2026-05-13T00:00:00.000Z",
          })
          yield* runs.markRunning("worker-1", "2026-05-13T00:01:00.000Z")
          yield* runs.complete("worker-1", validResult(), "2026-05-13T00:02:00.000Z", {
            isolation: "worktree",
            patch_path: "/tmp/worker-1.patch",
          })
          yield* runs.markIntegrated("worker-1", "2026-05-13T00:03:00.000Z")
          return yield* runs.get("worker-1")
        }).pipe(Effect.provide(WorkerRunsLive(root)), Effect.provide(EventStoreLive)),
      )

      expect(latest?.status).toBe("completed")
      expect(latest?.attempts).toBe(1)
      expect(latest?.started_at).toBe("2026-05-13T00:01:00.000Z")
      expect(latest?.stopped_at).toBe("2026-05-13T00:02:00.000Z")
      expect(latest?.output?.summary).toBe("worker finished")
      expect(latest?.result?.summary).toBe("worker finished")
      expect(latest?.patch_path).toBe("/tmp/worker-1.patch")
      expect(latest?.integration_status).toBe("applied")
      expect(latest?.integrated_at).toBe("2026-05-13T00:03:00.000Z")
      expect(latest?.failure_reason).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects malformed worker results without advancing the run", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-runs-"))
    try {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const runs = yield* WorkerRuns
          yield* runs.createQueued({
            worker_id: "worker-1",
            session_id: "session-1",
            agent_type: "executor",
            mode: "write-allowed",
            prompt_hash: "prompt-hash-1",
            scope: "src/**",
          })
          yield* runs.markRunning("worker-1")
          yield* runs.complete("worker-1", { summary: "missing required arrays" })
        }).pipe(Effect.provide(WorkerRunsLive(root)), Effect.provide(EventStoreLive)),
      )

      expect(exit._tag).toBe("Failure")

      const latest = await Effect.runPromise(
        Effect.gen(function* () {
          const runs = yield* WorkerRuns
          return yield* runs.get("worker-1")
        }).pipe(Effect.provide(WorkerRunsLive(root)), Effect.provide(EventStoreLive)),
      )
      expect(latest?.status).toBe("running")
      expect(latest?.output).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("requires a prompt hash or prompt when creating queued runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-runs-"))
    try {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const runs = yield* WorkerRuns
          yield* runs.createQueued({
            worker_id: "worker-1",
            session_id: "session-1",
            agent_type: "Explore",
            mode: "read-only",
            scope: "src/**",
          })
        }).pipe(Effect.provide(WorkerRunsLive(root)), Effect.provide(EventStoreLive)),
      )

      expect(exit._tag).toBe("Failure")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("lists latest snapshots per worker in last-update order", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-runs-"))
    try {
      const listed = await Effect.runPromise(
        Effect.gen(function* () {
          const runs = yield* WorkerRuns
          yield* runs.createQueued({
            worker_id: "worker-1",
            session_id: "session-1",
            agent_type: "Explore",
            mode: "read-only",
            prompt_hash: "prompt-hash-1",
            scope: "src/a.ts",
          })
          yield* runs.createQueued({
            worker_id: "worker-2",
            session_id: "session-1",
            agent_type: "architect",
            mode: "read-only",
            prompt_hash: "prompt-hash-2",
            scope: "src/b.ts",
          })
          yield* runs.markRunning("worker-1")
          return yield* runs.list(2)
        }).pipe(Effect.provide(WorkerRunsLive(root)), Effect.provide(EventStoreLive)),
      )

      expect(listed.map((run) => run.worker_id)).toEqual(["worker-2", "worker-1"])
      expect(listed.map((run) => run.status)).toEqual(["queued", "running"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("filters session and parent runs before applying caller limits", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-runs-"))
    try {
      const found = await Effect.runPromise(
        Effect.gen(function* () {
          const runs = yield* WorkerRuns
          yield* runs.createQueued({
            worker_id: "target-worker",
            session_id: "target-session",
            parent_task_id: "target-parent",
            agent_type: "executor",
            mode: "write-allowed",
            prompt_hash: "prompt-hash-target",
            scope: "src/**",
          })
          yield* runs.createQueued({
            worker_id: "other-worker",
            session_id: "other-session",
            parent_task_id: "other-parent",
            agent_type: "Explore",
            mode: "read-only",
            prompt_hash: "prompt-hash-other",
            scope: "src/**",
          })
          return {
            session: yield* runs.forSession("target-session", 1),
            parent: yield* runs.forParent("target-parent", 1),
          }
        }).pipe(Effect.provide(WorkerRunsLive(root)), Effect.provide(EventStoreLive)),
      )

      expect(found.session.map((run) => run.worker_id)).toEqual(["target-worker"])
      expect(found.parent.map((run) => run.worker_id)).toEqual(["target-worker"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("AppTest provides worker queue and worker run services together", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* WorkerQueue
        yield* WorkerRuns
        return "provided"
      }).pipe(Effect.provide(AppTest)),
    )

    expect(result).toBe("provided")
  })
})
