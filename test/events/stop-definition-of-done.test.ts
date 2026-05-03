import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { handleStop } from "../../src/events/stop-definition-of-done.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import {
  SessionState,
  SessionStateTest,
  EMPTY_SESSION_STATE,
} from "../../src/services/session-state.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const stop = (sid: string, active = false) =>
  decode({
    _tag: "Stop",
    session_id: sid,
    hook_event_name: "Stop",
    stop_hook_active: active,
  })

describe("handleStop (definition of done)", () => {
  test("red-team #5: blocks when files changed and no verification", async () => {
    const layer = SessionStateTest(
      new Map([
        [
          "sid-1",
          {
            ...EMPTY_SESSION_STATE,
            files_changed: ["/repo/a.ts"],
            verification_status: "none" as const,
          },
        ],
      ]),
    )
    const d = await Effect.runPromise(handleStop(stop("sid-1")).pipe(Effect.provide(layer)))
    const out = d as { decision?: string; reason?: string }
    expect(out.decision).toBe("block")
    expect(out.reason ?? "").toMatch(/verification/i)
  })

  test("stop_hook_active=true short-circuits to NoOp (no loop)", async () => {
    const layer = SessionStateTest(
      new Map([
        [
          "sid-2",
          {
            ...EMPTY_SESSION_STATE,
            files_changed: ["/repo/a.ts"],
            verification_status: "none" as const,
          },
        ],
      ]),
    )
    const d = await Effect.runPromise(
      handleStop(stop("sid-2", true)).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
  })

  test("never blocks twice in same session", async () => {
    const layer = SessionStateTest(
      new Map([
        [
          "sid-3",
          {
            ...EMPTY_SESSION_STATE,
            files_changed: ["/repo/a.ts"],
            verification_status: "none" as const,
          },
        ],
      ]),
    )
    const program = Effect.gen(function* () {
      const first = yield* handleStop(stop("sid-3"))
      const s = yield* SessionState
      const stateAfter = yield* s.get("sid-3")
      const second = yield* handleStop(stop("sid-3"))
      return { first, stateAfter, second }
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect((r.first as { decision?: string }).decision).toBe("block")
    expect(r.stateAfter.stop_blocked_once).toBe(true)
    expect(r.second).toEqual({})
  })

  test("allows stop when verification has passed", async () => {
    const layer = SessionStateTest(
      new Map([
        [
          "sid-4",
          {
            ...EMPTY_SESSION_STATE,
            files_changed: ["/repo/a.ts"],
            verification_status: "passed" as const,
          },
        ],
      ]),
    )
    const d = await Effect.runPromise(handleStop(stop("sid-4")).pipe(Effect.provide(layer)))
    expect(d).toEqual({})
  })

  test("allows stop when no files changed", async () => {
    const layer = SessionStateTest()
    const d = await Effect.runPromise(handleStop(stop("sid-5")).pipe(Effect.provide(layer)))
    expect(d).toEqual({})
  })
})
