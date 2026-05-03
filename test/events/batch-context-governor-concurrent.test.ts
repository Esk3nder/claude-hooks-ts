import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { handlePostToolBatch } from "../../src/events/batch-context-governor.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import {
  SessionState,
  type SessionStateApi,
  EMPTY_SESSION_STATE,
} from "../../src/services/session-state.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

interface Counter {
  readonly appendCount: Ref.Ref<number>
  readonly batchCount: Ref.Ref<number>
  readonly lastBatchSize: Ref.Ref<number>
}

const SlowSessionStateLayer = (
  delayMs: number,
  counter: Counter,
): Layer.Layer<SessionState> =>
  Layer.effect(
    SessionState,
    Effect.sync(() => {
      const api: SessionStateApi = {
        get: () => Effect.succeed(EMPTY_SESSION_STATE),
        update: () => Effect.void,
        append: () =>
          Effect.gen(function* () {
            yield* Ref.update(counter.appendCount, (n) => n + 1)
            yield* Effect.sleep(`${delayMs} millis`)
          }),
        appendBatch: ((...args: ReadonlyArray<unknown>) => {
          const entries = (typeof args[0] === "string"
            ? args[1]
            : args[0]) as ReadonlyArray<{ key: string; value: string }>
          return Effect.gen(function* () {
            yield* Ref.update(counter.batchCount, (n) => n + 1)
            yield* Ref.set(counter.lastBatchSize, entries.length)
            yield* Ref.update(counter.appendCount, (n) => n + entries.length)
            yield* Effect.sleep(`${delayMs} millis`)
          })
        }) as SessionStateApi["appendBatch"],
      }
      return SessionState.of(api)
    }),
  )

describe("handlePostToolBatch — coalesced appendBatch", () => {
  test("multiple per-tool entries collapse into a single appendBatch call", async () => {
    const counter: Counter = {
      appendCount: Effect.runSync(Ref.make(0)),
      batchCount: Effect.runSync(Ref.make(0)),
      lastBatchSize: Effect.runSync(Ref.make(0)),
    }
    const N = 8
    const tools = Array.from({ length: N }, (_, i) => ({
      tool_name: "Edit" as const,
      tool_input: { file_path: `/repo/file-${i}.ts` },
    }))
    const payload = decode({
      _tag: "PostToolBatch",
      session_id: "sid-batch",
      hook_event_name: "PostToolBatch",
      tools,
    })

    const layer = SlowSessionStateLayer(10, counter)
    await Effect.runPromise(
      handlePostToolBatch(payload).pipe(Effect.provide(layer)),
    )

    const batchCount = await Effect.runPromise(Ref.get(counter.batchCount))
    const lastBatchSize = await Effect.runPromise(
      Ref.get(counter.lastBatchSize),
    )

    expect(batchCount).toBe(1)
    expect(lastBatchSize).toBe(N)
  })

  test("a slow appendBatch is bounded by 500ms timeout (orElseSucceed undefined)", async () => {
    const counter: Counter = {
      appendCount: Effect.runSync(Ref.make(0)),
      batchCount: Effect.runSync(Ref.make(0)),
      lastBatchSize: Effect.runSync(Ref.make(0)),
    }
    // 2 second appendBatch delay — must be cut off by the 500ms timeout.
    const layer = SlowSessionStateLayer(2000, counter)
    const payload = decode({
      _tag: "PostToolBatch",
      session_id: "sid-slow",
      hook_event_name: "PostToolBatch",
      tools: [
        { tool_name: "Edit", tool_input: { file_path: "/repo/x.ts" } },
      ],
    })

    const start = Date.now()
    const decision = await Effect.runPromise(
      handlePostToolBatch(payload).pipe(Effect.provide(layer)),
    )
    const elapsed = Date.now() - start

    // Bounded by timeout (+ generous buffer for runtime overhead)
    expect(elapsed).toBeLessThan(1500)
    // Hook still produces a valid decision (does not fail)
    expect(decision).toBeDefined()
  })
})

// keep `Context` import meaningful even if unused at top level
void Context
