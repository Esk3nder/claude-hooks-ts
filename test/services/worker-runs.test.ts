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

  // P2-1: createQueued without an explicit worker_id should generate
  // a UUIDv4-shaped ID. Pre-fix the format was
  // `worker-${Date.now()}-${randomBytes(4).hex}` which is clock-
  // dependent and only 32 bits of entropy per ms.
  test("createQueued generates UUIDv4-shaped worker IDs (P2-1)", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-runs-uuid-"))
    try {
      const ids = await Effect.runPromise(
        Effect.gen(function* () {
          const runs = yield* WorkerRuns
          const a = yield* runs.createQueued({
            session_id: "session-1",
            agent_type: "Explore",
            mode: "read-only",
            prompt: "p1",
            scope: "src/**",
            created_at: "2026-05-13T00:00:00.000Z",
          })
          const b = yield* runs.createQueued({
            session_id: "session-1",
            agent_type: "Explore",
            mode: "read-only",
            prompt: "p2",
            scope: "src/**",
            created_at: "2026-05-13T00:00:00.000Z",
          })
          return [a.worker_id, b.worker_id]
        }).pipe(Effect.provide(WorkerRunsLive(root)), Effect.provide(EventStoreLive)),
      )
      const uuidPattern =
        /^worker-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      expect(ids[0]).toMatch(uuidPattern)
      expect(ids[1]).toMatch(uuidPattern)
      // Distinct across two calls — sanity check that the generator
      // is not returning a stable value.
      expect(ids[0]).not.toBe(ids[1])
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
          yield* runs.markIntegrationRejected("worker-1", "patch does not apply", "2026-05-13T00:02:30.000Z")
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

  test("rejects invalid integration transitions", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-runs-"))
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const runs = yield* WorkerRuns
          yield* runs.createQueued({
            worker_id: "worker-queued",
            session_id: "session-1",
            agent_type: "executor",
            mode: "write-allowed",
            prompt_hash: "prompt-hash-queued",
            scope: "src/**",
          })
          const queued = yield* runs.markIntegrated("worker-queued").pipe(Effect.either)

          yield* runs.createQueued({
            worker_id: "worker-readonly",
            session_id: "session-1",
            agent_type: "Explore",
            mode: "read-only",
            prompt_hash: "prompt-hash-readonly",
            scope: "src/**",
          })
          yield* runs.complete("worker-readonly", {
            ...validResult("read-only"),
            changes_made: [],
          })
          const readOnly = yield* runs.markIntegrated("worker-readonly").pipe(Effect.either)

          yield* runs.createQueued({
            worker_id: "worker-patchless",
            session_id: "session-1",
            agent_type: "executor",
            mode: "write-allowed",
            prompt_hash: "prompt-hash-patchless",
            scope: "src/**",
          })
          yield* runs.complete("worker-patchless", validResult("patchless"))
          const patchless = yield* runs.markIntegrated("worker-patchless").pipe(Effect.either)

          return {
            queued,
            readOnly,
            patchless,
            latestQueued: yield* runs.get("worker-queued"),
            latestReadOnly: yield* runs.get("worker-readonly"),
            latestPatchless: yield* runs.get("worker-patchless"),
          }
        }).pipe(Effect.provide(WorkerRunsLive(root)), Effect.provide(EventStoreLive)),
      )

      expect(result.queued._tag).toBe("Left")
      expect(result.readOnly._tag).toBe("Left")
      expect(result.patchless._tag).toBe("Left")
      expect(result.latestQueued?.integration_status).toBeUndefined()
      expect(result.latestReadOnly?.integration_status).toBeUndefined()
      expect(result.latestPatchless?.integration_status).toBeUndefined()
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

  test("rejects blank patch metadata without advancing the run", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-runs-"))
    try {
      const result = await Effect.runPromise(
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
          const exit = yield* runs.complete("worker-1", validResult(), undefined, {
            isolation: "worktree",
            patch_path: "   ",
          }).pipe(Effect.either)
          return {
            exit,
            latest: yield* runs.get("worker-1"),
          }
        }).pipe(Effect.provide(WorkerRunsLive(root)), Effect.provide(EventStoreLive)),
      )

      expect(result.exit._tag).toBe("Left")
      expect(result.latest?.status).toBe("running")
      expect(result.latest?.patch_path).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("completed worker runs are idempotent and cannot be overwritten by stale completions", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-runs-"))
    try {
      const latest = await Effect.runPromise(
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
          yield* runs.complete("worker-1", validResult("first"), undefined, {
            isolation: "worktree",
            patch_path: "/tmp/worker-1.patch",
          })
          yield* runs.markIntegrated("worker-1")
          const second = yield* runs.complete("worker-1", {
            ...validResult("second"),
            changes_made: [],
          }).pipe(Effect.either)
          return { second, latest: yield* runs.get("worker-1") }
        }).pipe(Effect.provide(WorkerRunsLive(root)), Effect.provide(EventStoreLive)),
      )

      expect(latest.latest?.status).toBe("completed")
      expect(latest.latest?.result?.summary).toBe("first")
      expect(latest.second._tag).toBe("Left")
      expect(latest.latest?.patch_path).toBe("/tmp/worker-1.patch")
      expect(latest.latest?.integration_status).toBe("applied")
      expect(latest.latest?.integrated_at).toBeDefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("idempotent completion is insensitive to result object key order", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-runs-"))
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const runs = yield* WorkerRuns
          yield* runs.createQueued({
            worker_id: "worker-ordered",
            session_id: "session-1",
            agent_type: "executor",
            mode: "write-allowed",
            prompt_hash: "prompt-hash-ordered",
            scope: "src/**",
          })
          yield* runs.markRunning("worker-ordered")
          const completion = validResult("same")
          yield* runs.complete("worker-ordered", completion, undefined, {
            isolation: "worktree",
            patch_path: "/tmp/worker-ordered.patch",
          })
          const reordered: WorkerResult = {
            confidence: "high",
            blockers: [],
            risks: [],
            verification: completion.verification,
            commands_run: completion.commands_run,
            changes_made: completion.changes_made,
            files_relevant: completion.files_relevant,
            summary: "same",
          }
          const second = yield* runs.complete("worker-ordered", reordered, undefined, {
            isolation: "worktree",
            patch_path: "/tmp/worker-ordered.patch",
          }).pipe(Effect.either)
          return {
            second,
            latest: yield* runs.get("worker-ordered"),
          }
        }).pipe(Effect.provide(WorkerRunsLive(root)), Effect.provide(EventStoreLive)),
      )

      expect(result.second._tag).toBe("Right")
      expect(result.latest?.status).toBe("completed")
      expect(result.latest?.result?.summary).toBe("same")
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

  test("rejects duplicate worker ids without rewinding the latest run", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-runs-"))
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const runs = yield* WorkerRuns
          yield* runs.createQueued({
            worker_id: "worker-1",
            session_id: "session-1",
            agent_type: "Explore",
            mode: "read-only",
            prompt_hash: "prompt-hash-1",
            scope: "src/**",
          })
          yield* runs.markRunning("worker-1")
          const duplicate = yield* runs.createQueued({
            worker_id: "worker-1",
            session_id: "session-1",
            agent_type: "Explore",
            mode: "read-only",
            prompt_hash: "prompt-hash-2",
            scope: "other/**",
          }).pipe(Effect.either)
          return {
            duplicate,
            latest: yield* runs.get("worker-1"),
          }
        }).pipe(Effect.provide(WorkerRunsLive(root)), Effect.provide(EventStoreLive)),
      )

      expect(result.duplicate._tag).toBe("Left")
      expect(result.latest?.status).toBe("running")
      expect(result.latest?.prompt_hash).toBe("prompt-hash-1")
      expect(result.latest?.scope).toBe("src/**")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("terminal runs cannot be restarted or failed again", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-worker-runs-"))
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const runs = yield* WorkerRuns
          yield* runs.createQueued({
            worker_id: "worker-terminal",
            session_id: "session-1",
            agent_type: "executor",
            mode: "write-allowed",
            prompt_hash: "prompt-hash-terminal",
            scope: "src/**",
          })
          yield* runs.markRunning("worker-terminal")
          yield* runs.complete("worker-terminal", validResult("done"))
          const restart = yield* runs.markRunning("worker-terminal").pipe(Effect.either)
          const refail = yield* runs.fail("worker-terminal", "late failure").pipe(Effect.either)
          return {
            restart,
            refail,
            latest: yield* runs.get("worker-terminal"),
          }
        }).pipe(Effect.provide(WorkerRunsLive(root)), Effect.provide(EventStoreLive)),
      )

      expect(result.restart._tag).toBe("Left")
      expect(result.refail._tag).toBe("Left")
      expect(result.latest?.status).toBe("completed")
      expect(result.latest?.result?.summary).toBe("done")
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
