import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventStoreLive } from "../../src/services/event-store.ts"
import { WorkerQueue, WorkerQueueLive } from "../../src/services/worker-queue.ts"

describe("WorkerQueueLive", () => {
  test("offers jobs through Queue and consumes them as a Stream", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-workers-"))
    try {
      const job = {
        id: "job-1",
        queue: "default",
        payload: { prompt: "do not persist raw prompt" },
        enqueuedAt: Date.now(),
        attempts: 0,
      }

      const consumed = await Effect.runPromise(
        Effect.gen(function* () {
          const queue = yield* WorkerQueue
          yield* queue.offer(job)
          return yield* Stream.runHead(queue.stream)
        }).pipe(Effect.provide(WorkerQueueLive(root)), Effect.provide(EventStoreLive)),
      )

      expect(consumed._tag).toBe("Some")
      if (consumed._tag === "Some") expect(consumed.value.id).toBe("job-1")

      const file = join(root, ".claude-hooks", "state", "workers", "default.jsonl")
      const persisted = readFileSync(file, "utf8")
      expect(persisted).toContain("job-1")
      expect(persisted).not.toContain("do not persist raw prompt")
      expect(persisted).toContain("redacted")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("offer fails instead of silently enqueueing when persistence fails", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "chts-workers-")), "not-a-dir")
    writeFileSync(root, "file")
    try {
      const job = {
        id: "job-1",
        queue: "default",
        payload: {},
        enqueuedAt: Date.now(),
        attempts: 0,
      }

      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const queue = yield* WorkerQueue
          yield* queue.offer(job)
        }).pipe(Effect.provide(WorkerQueueLive(root)), Effect.provide(EventStoreLive)),
      )

      expect(result._tag).toBe("Failure")
    } finally {
      rmSync(root, { force: true })
      rmSync(join(root, ".."), { recursive: true, force: true })
    }
  })

  test("full queue failure does not persist a job that was not enqueued", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-workers-"))
    try {
      const first = {
        id: "job-1",
        queue: "default",
        payload: {},
        enqueuedAt: Date.now(),
        attempts: 0,
      }
      const second = {
        ...first,
        id: "job-2",
        enqueuedAt: first.enqueuedAt + 1,
      }

      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const queue = yield* WorkerQueue
          yield* queue.offer(first)
          yield* queue.offer(second)
        }).pipe(Effect.provide(WorkerQueueLive(root, "default", 1)), Effect.provide(EventStoreLive)),
      )

      expect(result._tag).toBe("Failure")
      const file = join(root, ".claude-hooks", "state", "workers", "default.jsonl")
      const persisted = readFileSync(file, "utf8")
      expect(persisted).toContain("job-1")
      expect(persisted).not.toContain("job-2")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
