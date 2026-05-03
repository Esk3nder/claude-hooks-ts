import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { handleStop } from "../../src/events/stop-definition-of-done.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import {
  SessionStateTest,
  EMPTY_SESSION_STATE,
} from "../../src/services/session-state.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)
const stop = (sid: string) =>
  decode({
    _tag: "Stop",
    session_id: sid,
    hook_event_name: "Stop",
  })

describe("handleStop (research-mode source-ledger gate, VAL-M5-001)", () => {
  test("blocks when last_workflow=research.* and no source URLs", async () => {
    const layer = SessionStateTest(
      new Map([
        [
          "r1",
          {
            ...EMPTY_SESSION_STATE,
            last_workflow: "research.web",
          },
        ],
      ]),
    )
    const d = await Effect.runPromise(
      handleStop(stop("r1")).pipe(Effect.provide(layer)),
    )
    const out = d as { decision?: string; reason?: string }
    expect(out.decision).toBe("block")
    expect(out.reason ?? "").toMatch(/source ledger/i)
  })

  test("allows when research.* has source URLs recorded", async () => {
    const layer = SessionStateTest(
      new Map([
        [
          "r2",
          {
            ...EMPTY_SESSION_STATE,
            last_workflow: "research.synthesis",
            source_urls: ["https://example.com/a"],
          },
        ],
      ]),
    )
    const d = await Effect.runPromise(
      handleStop(stop("r2")).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
  })

  test("does not trigger research gate for coding.* workflow", async () => {
    const layer = SessionStateTest(
      new Map([
        [
          "c1",
          {
            ...EMPTY_SESSION_STATE,
            last_workflow: "coding.fix",
          },
        ],
      ]),
    )
    const d = await Effect.runPromise(
      handleStop(stop("c1")).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
  })

  test("loop-guard: stop_blocked_once short-circuits to NoOp even in research mode", async () => {
    const layer = SessionStateTest(
      new Map([
        [
          "r3",
          {
            ...EMPTY_SESSION_STATE,
            last_workflow: "research.web",
            stop_blocked_once: true,
          },
        ],
      ]),
    )
    const d = await Effect.runPromise(
      handleStop(stop("r3")).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
  })
})
