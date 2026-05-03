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
  readonly inFlight: Ref.Ref<number>
  readonly maxInFlight: Ref.Ref<number>
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
            const cur = yield* Ref.updateAndGet(counter.inFlight, (n) => n + 1)
            yield* Ref.update(counter.maxInFlight, (m) => (cur > m ? cur : m))
            yield* Effect.sleep(`${delayMs} millis`)
            yield* Ref.update(counter.inFlight, (n) => n - 1)
          }),
      }
      return SessionState.of(api)
    }),
  )

describe("handlePostToolBatch — concurrent fan-out", () => {
  test("all branches run concurrently; elapsed < serial sum", async () => {
    const counter: Counter = {
      appendCount: Effect.runSync(Ref.make(0)),
      inFlight: Effect.runSync(Ref.make(0)),
      maxInFlight: Effect.runSync(Ref.make(0)),
    }
    const N = 8
    const delayPerBranch = 50 // ms
    const tools = Array.from({ length: N }, (_, i) => ({
      tool_name: "Edit" as const,
      tool_input: { file_path: `/repo/file-${i}.ts` },
    }))
    const payload = decode({
      _tag: "PostToolBatch",
      session_id: "sid-concurrent",
      hook_event_name: "PostToolBatch",
      tools,
    })

    const layer = SlowSessionStateLayer(delayPerBranch, counter)
    const start = Date.now()
    await Effect.runPromise(
      handlePostToolBatch(payload).pipe(Effect.provide(layer)),
    )
    const elapsed = Date.now() - start

    const appendCount = await Effect.runPromise(Ref.get(counter.appendCount))
    const maxInFlight = await Effect.runPromise(Ref.get(counter.maxInFlight))

    expect(appendCount).toBe(N)
    // Concurrency proof: total elapsed must be much less than serial sum
    expect(elapsed).toBeLessThan(N * delayPerBranch)
    // And we should have observed multiple in-flight at once
    expect(maxInFlight).toBeGreaterThan(1)
  })

  test("a single slow branch is bounded by 500ms timeout (orElseSucceed null)", async () => {
    const counter: Counter = {
      appendCount: Effect.runSync(Ref.make(0)),
      inFlight: Effect.runSync(Ref.make(0)),
      maxInFlight: Effect.runSync(Ref.make(0)),
    }
    // 2 second per-append delay — must be cut off by the 500ms timeout.
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
