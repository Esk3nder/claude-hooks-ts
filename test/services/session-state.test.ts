import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  SessionState,
  SessionStateTest,
  EMPTY_SESSION_STATE,
} from "../../src/services/session-state.ts"

describe("SessionState (test layer)", () => {
  test("get returns empty record for unknown session", async () => {
    const program = Effect.gen(function* () {
      const s = yield* SessionState
      return yield* s.get("missing")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(SessionStateTest())))
    expect(r).toEqual(EMPTY_SESSION_STATE)
  })

  test("update merges patch", async () => {
    const program = Effect.gen(function* () {
      const s = yield* SessionState
      yield* s.update("sid", { verification_status: "passed" })
      return yield* s.get("sid")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(SessionStateTest())))
    expect(r.verification_status).toBe("passed")
  })

  test("append deduplicates", async () => {
    const program = Effect.gen(function* () {
      const s = yield* SessionState
      yield* s.append("sid", "files_changed", "/a")
      yield* s.append("sid", "files_changed", "/a")
      yield* s.append("sid", "files_changed", "/b")
      return yield* s.get("sid")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(SessionStateTest())))
    expect(r.files_changed).toEqual(["/a", "/b"])
  })

  test("stop_blocked_once flag round-trips", async () => {
    const program = Effect.gen(function* () {
      const s = yield* SessionState
      yield* s.update("sid", { stop_blocked_once: true })
      return yield* s.get("sid")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(SessionStateTest())))
    expect(r.stop_blocked_once).toBe(true)
  })
})
