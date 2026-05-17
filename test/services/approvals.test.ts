import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { EventStoreError } from "../../src/schema/errors.ts"
import { Approvals, ApprovalsLiveBase, ApprovalsTest } from "../../src/services/approvals.ts"
import { EventStore } from "../../src/services/event-store.ts"
import { FileLockPlatformLive } from "../../src/services/file-lock.ts"

const failingEventStore = (failure: EventStoreError): Layer.Layer<EventStore> =>
  Layer.succeed(
    EventStore,
    EventStore.of({
      append: () => Effect.fail(failure),
      tail: () => Stream.fail(failure),
      compact: () => Effect.fail(failure),
    }),
  )

describe("Approvals (test layer)", () => {
  test("lookup returns null for unknown pattern", async () => {
    const program = Effect.gen(function* () {
      const a = yield* Approvals
      return yield* a.lookup("/repo", "Bash:bash:git status")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(ApprovalsTest())))
    expect(r).toBeNull()
  })

  test("seeded approval is returned", async () => {
    const program = Effect.gen(function* () {
      const a = yield* Approvals
      return yield* a.lookup("/repo", "Bash:bash:git status")
    })
    const layer = ApprovalsTest([
      {
        cwd: "/repo",
        pattern: "Bash:bash:git status",
        status: "approved",
        recordedAt: 1,
      },
    ])
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r?.status).toBe("approved")
  })

  test("record then lookup", async () => {
    const program = Effect.gen(function* () {
      const a = yield* Approvals
      yield* a.record({
        cwd: "/repo",
        pattern: "Edit:path:*.ts",
        status: "denied",
        recordedAt: 5,
      })
      return yield* a.lookup("/repo", "Edit:path:*.ts")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(ApprovalsTest())))
    expect(r?.status).toBe("denied")
  })

  test("latest record wins", async () => {
    const program = Effect.gen(function* () {
      const a = yield* Approvals
      yield* a.record({
        cwd: "/r",
        pattern: "p",
        status: "approved",
        recordedAt: 1,
      })
      yield* a.record({
        cwd: "/r",
        pattern: "p",
        status: "denied",
        recordedAt: 10,
      })
      return yield* a.lookup("/r", "p")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(ApprovalsTest())))
    expect(r?.status).toBe("denied")
  })

  test("event-store failures are summarized without serializing raw causes", async () => {
    const failure = new EventStoreError({
      op: "tail",
      stream: "approvals:/repo",
      path: "/repo/.claude-hooks/state/approvals.jsonl",
      message: "event schema decode failed",
      cause: { prompt: "TOP_SECRET_APPROVAL_CAUSE" },
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const a = yield* Approvals
        return yield* Effect.either(a.lookup("/repo", "p"))
      }).pipe(
        Effect.provide(
          Layer.provide(
            ApprovalsLiveBase,
            Layer.merge(failingEventStore(failure), FileLockPlatformLive),
          ),
        ),
      ),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.message).toBe("tail failed for approvals:/repo: event schema decode failed")
      expect(JSON.stringify(result.left)).not.toContain("TOP_SECRET_APPROVAL_CAUSE")
      expect(JSON.stringify(result.left)).not.toContain("prompt")
    }
  })
})
