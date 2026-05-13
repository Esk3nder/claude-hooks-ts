import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema, Stream } from "effect"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventStoreLive } from "../../src/services/event-store.ts"
import { RuntimeConfigTest } from "../../src/services/runtime-config.ts"
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
        }).pipe(
          Effect.provide(WorkerQueueLive(root)),
          Effect.provide(EventStoreLive),
          Effect.provide(RuntimeConfigTest()),
        ),
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

  test("redacts raw string payloads before persistence", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-workers-"))
    try {
      const job = {
        id: "job-raw",
        queue: "default",
        payload: "raw tool_input and prompt content must not persist",
        enqueuedAt: Date.now(),
        attempts: 0,
      }

      await Effect.runPromise(
        Effect.gen(function* () {
          const queue = yield* WorkerQueue
          yield* queue.offer(job)
        }).pipe(
          Effect.provide(WorkerQueueLive(root)),
          Effect.provide(EventStoreLive),
          Effect.provide(RuntimeConfigTest()),
        ),
      )

      const file = join(root, ".claude-hooks", "state", "workers", "default.jsonl")
      const persisted = readFileSync(file, "utf8")
      expect(persisted).toContain("job-raw")
      expect(persisted).toContain("redacted")
      expect(persisted).not.toContain("raw tool_input")
      expect(persisted).not.toContain("prompt content")
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
        }).pipe(
          Effect.provide(WorkerQueueLive(root)),
          Effect.provide(EventStoreLive),
          Effect.provide(RuntimeConfigTest()),
        ),
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
        }).pipe(
          Effect.provide(WorkerQueueLive(root, "default", 1)),
          Effect.provide(EventStoreLive),
          Effect.provide(RuntimeConfigTest()),
        ),
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

  test("capacity defaults to RuntimeConfigService", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-workers-"))
    try {
      const first = {
        id: "job-config-1",
        queue: "default",
        payload: {},
        enqueuedAt: Date.now(),
        attempts: 0,
      }
      const second = {
        ...first,
        id: "job-config-2",
        enqueuedAt: first.enqueuedAt + 1,
      }

      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const queue = yield* WorkerQueue
          yield* queue.offer(first)
          yield* queue.offer(second)
        }).pipe(
          Effect.provide(WorkerQueueLive(root)),
          Effect.provide(EventStoreLive),
          Effect.provide(RuntimeConfigTest({ workerQueueCapacity: 1 })),
        ),
      )

      expect(result._tag).toBe("Failure")
      const file = join(root, ".claude-hooks", "state", "workers", "default.jsonl")
      const persisted = readFileSync(file, "utf8")
      expect(persisted).toContain("job-config-1")
      expect(persisted).not.toContain("job-config-2")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("replays unclaimed non-sensitive jobs after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-workers-"))
    try {
      const job = {
        id: "job-replay",
        queue: "default",
        payload: { kind: "safe-control-job" },
        enqueuedAt: Date.now(),
        attempts: 0,
      }

      await Effect.runPromise(
        Effect.gen(function* () {
          const queue = yield* WorkerQueue
          yield* queue.offer(job)
        }).pipe(
          Effect.provide(WorkerQueueLive(root)),
          Effect.provide(EventStoreLive),
          Effect.provide(RuntimeConfigTest()),
        ),
      )

      const replayed = await Effect.runPromise(
        Effect.gen(function* () {
          const queue = yield* WorkerQueue
          return yield* queue.take
        }).pipe(
          Effect.provide(WorkerQueueLive(root)),
          Effect.provide(EventStoreLive),
          Effect.provide(RuntimeConfigTest()),
        ),
      )

      expect(replayed.id).toBe("job-replay")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("replays worker payload jobs only with non-executable redacted prompt descriptors", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-workers-"))
    try {
      const secret = "sk-12345678901234567890"
      const job = {
        id: "job-worker-payload",
        queue: "default",
        payload: {
          session_id: "session-1",
          agent_type: "executor",
          mode: "write-allowed" as const,
          prompt: `inspect src with token ${secret}`,
          scope: "src/**",
        },
        enqueuedAt: Date.now(),
        attempts: 0,
      }

      await Effect.runPromise(
        Effect.gen(function* () {
          const queue = yield* WorkerQueue
          yield* queue.offer(job)
        }).pipe(
          Effect.provide(WorkerQueueLive(root)),
          Effect.provide(EventStoreLive),
          Effect.provide(RuntimeConfigTest()),
        ),
      )

      const persisted = readFileSync(join(root, ".claude-hooks", "state", "workers", "default.jsonl"), "utf8")
      expect(persisted).toContain("job-worker-payload")
      expect(persisted).toContain("prompt_hash")
      expect(persisted).toContain("redacted worker prompt")
      expect(persisted).not.toContain(secret)
      expect(persisted).not.toContain("inspect src")

      const replayed = await Effect.runPromise(
        Effect.gen(function* () {
          const queue = yield* WorkerQueue
          return yield* queue.take
        }).pipe(
          Effect.provide(WorkerQueueLive(root)),
          Effect.provide(EventStoreLive),
          Effect.provide(RuntimeConfigTest()),
        ),
      )
      const payload = Schema.decodeUnknownSync(
        Schema.Struct({
          prompt: Schema.String,
          prompt_hash: Schema.String,
          prompt_redacted: Schema.Boolean,
        }),
      )(replayed.payload)

      expect(replayed.id).toBe("job-worker-payload")
      expect(payload.prompt).toContain("redacted worker prompt")
      expect(payload.prompt).not.toContain(secret)
      expect(payload.prompt).not.toContain("inspect src")
      expect(payload.prompt_hash).toHaveLength(16)
      expect(payload.prompt_redacted).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("replays older persisted jobs before newer backlog entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-workers-"))
    try {
      const jobs = Array.from({ length: 3 }, (_, index) => ({
        id: `job-${index + 1}`,
        queue: "default",
        payload: { kind: "safe-control-job", order: index + 1 },
        enqueuedAt: Date.now() + index,
        attempts: 0,
      }))

      await Effect.runPromise(
        Effect.gen(function* () {
          const queue = yield* WorkerQueue
          for (const job of jobs) yield* queue.offer(job)
        }).pipe(
          Effect.provide(WorkerQueueLive(root, "default", 3)),
          Effect.provide(EventStoreLive),
          Effect.provide(RuntimeConfigTest()),
        ),
      )

      const replayedIds = await Effect.runPromise(
        Effect.gen(function* () {
          const queue = yield* WorkerQueue
          const first = yield* queue.take
          yield* queue.complete(first.id)
          const second = yield* queue.take
          yield* queue.complete(second.id)
          const third = yield* queue.take
          return [first.id, second.id, third.id]
        }).pipe(
          Effect.provide(WorkerQueueLive(root, "default", 2)),
          Effect.provide(EventStoreLive),
          Effect.provide(RuntimeConfigTest()),
        ),
      )

      expect(replayedIds).toEqual(["job-1", "job-2", "job-3"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("replays claimed non-sensitive jobs whose lease expired", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-workers-"))
    try {
      const job = {
        id: "job-stale-claim",
        queue: "default",
        payload: { kind: "safe-control-job" },
        enqueuedAt: Date.now(),
        attempts: 0,
      }

      await Effect.runPromise(
        Effect.gen(function* () {
          const queue = yield* WorkerQueue
          yield* queue.offer(job)
          return yield* queue.take
        }).pipe(
          Effect.provide(WorkerQueueLive(root)),
          Effect.provide(EventStoreLive),
          Effect.provide(RuntimeConfigTest()),
        ),
      )

      const claimsFile = join(root, ".claude-hooks", "state", "workers", "default.claims.jsonl")
      const staleClaims = readFileSync(claimsFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => ({ ...JSON.parse(line), leaseUntil: 1 }))
        .map((claim) => `${JSON.stringify(claim)}\n`)
        .join("")
      writeFileSync(claimsFile, staleClaims)

      const replayed = await Effect.runPromise(
        Effect.gen(function* () {
          const queue = yield* WorkerQueue
          return yield* queue.take
        }).pipe(
          Effect.provide(WorkerQueueLive(root)),
          Effect.provide(EventStoreLive),
          Effect.provide(RuntimeConfigTest()),
        ),
      )

      expect(replayed.id).toBe("job-stale-claim")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("does not replay completed jobs after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-workers-"))
    try {
      const job = {
        id: "job-completed",
        queue: "default",
        payload: { kind: "safe-control-job" },
        enqueuedAt: Date.now(),
        attempts: 0,
      }

      await Effect.runPromise(
        Effect.gen(function* () {
          const queue = yield* WorkerQueue
          yield* queue.offer(job)
          const claimed = yield* queue.take
          yield* queue.complete(claimed.id)
        }).pipe(
          Effect.provide(WorkerQueueLive(root)),
          Effect.provide(EventStoreLive),
          Effect.provide(RuntimeConfigTest()),
        ),
      )

      const replayed = await Effect.runPromise(
        Effect.gen(function* () {
          const queue = yield* WorkerQueue
          return yield* queue.take.pipe(Effect.timeoutOption("20 millis"))
        }).pipe(
          Effect.provide(WorkerQueueLive(root)),
          Effect.provide(EventStoreLive),
          Effect.provide(RuntimeConfigTest()),
        ),
      )

      expect(replayed._tag).toBe("None")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("treats legacy claims without leaseUntil as stale after the default lease", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-workers-"))
    try {
      const job = {
        id: "job-legacy-claim",
        queue: "default",
        payload: { kind: "safe-control-job" },
        enqueuedAt: Date.now(),
        attempts: 0,
      }

      await Effect.runPromise(
        Effect.gen(function* () {
          const queue = yield* WorkerQueue
          yield* queue.offer(job)
          return yield* queue.take
        }).pipe(
          Effect.provide(WorkerQueueLive(root)),
          Effect.provide(EventStoreLive),
          Effect.provide(RuntimeConfigTest()),
        ),
      )

      const claimsFile = join(root, ".claude-hooks", "state", "workers", "default.claims.jsonl")
      const legacyClaims = readFileSync(claimsFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const claim = JSON.parse(line)
          delete claim.leaseUntil
          return { ...claim, claimedAt: 1 }
        })
        .map((claim) => `${JSON.stringify(claim)}\n`)
        .join("")
      writeFileSync(claimsFile, legacyClaims)

      const replayed = await Effect.runPromise(
        Effect.gen(function* () {
          const queue = yield* WorkerQueue
          return yield* queue.take
        }).pipe(
          Effect.provide(WorkerQueueLive(root)),
          Effect.provide(EventStoreLive),
          Effect.provide(RuntimeConfigTest()),
        ),
      )

      expect(replayed.id).toBe("job-legacy-claim")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("drops legacy unreplayable prompt-only jobs during recovery without bricking the queue", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-workers-"))
    try {
      const job = {
        id: "job-prompt",
        queue: "default",
        payload: { prompt: "sensitive worker prompt" },
        enqueuedAt: Date.now(),
        attempts: 0,
      }

      await Effect.runPromise(
        Effect.gen(function* () {
          const queue = yield* WorkerQueue
          yield* queue.offer(job)
        }).pipe(
          Effect.provide(WorkerQueueLive(root)),
          Effect.provide(EventStoreLive),
          Effect.provide(RuntimeConfigTest()),
        ),
      )

      const replayed = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const queue = yield* WorkerQueue
          return yield* queue.take.pipe(Effect.timeoutOption("20 millis"))
        }).pipe(
          Effect.provide(WorkerQueueLive(root)),
          Effect.provide(EventStoreLive),
          Effect.provide(RuntimeConfigTest()),
        ),
      )

      expect(replayed._tag).toBe("Success")
      if (replayed._tag === "Success") {
        expect(Option.isNone(replayed.value)).toBe(true)
      }

      const claims = readFileSync(join(root, ".claude-hooks", "state", "workers", "default.claims.jsonl"), "utf8")
      expect(claims).toContain("job-prompt")
      expect(claims).toContain("completedAt")

      const freshJob = { ...job, id: "job-after-recovery", payload: { safe: "metadata" } }
      const recovered = await Effect.runPromise(
        Effect.gen(function* () {
          const queue = yield* WorkerQueue
          yield* queue.offer(freshJob)
          return yield* queue.take
        }).pipe(
          Effect.provide(WorkerQueueLive(root)),
          Effect.provide(EventStoreLive),
          Effect.provide(RuntimeConfigTest()),
        ),
      )
      expect(recovered.id).toBe("job-after-recovery")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
