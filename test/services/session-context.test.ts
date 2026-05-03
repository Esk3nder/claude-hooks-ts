import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  withSession,
  getCurrentSession,
} from "../../src/services/session-context.ts"
import {
  SessionState,
  SessionStateTest,
} from "../../src/services/session-state.ts"

describe("session-context FiberRef (Item #7)", () => {
  test("getCurrentSession reads value set by withSession", async () => {
    const program = Effect.gen(function* () {
      const inner = Effect.gen(function* () {
        return yield* getCurrentSession()
      })
      return yield* withSession("test-id", inner)
    })
    const r = await Effect.runPromise(program)
    expect(r).toBe("test-id")
  })

  test("getCurrentSession is null outside withSession", async () => {
    const r = await Effect.runPromise(getCurrentSession())
    expect(r).toBe(null)
  })

  test("nested withSession uses innermost binding", async () => {
    const program = withSession(
      "outer",
      withSession(
        "inner",
        Effect.gen(function* () {
          return yield* getCurrentSession()
        }),
      ),
    )
    const r = await Effect.runPromise(program)
    expect(r).toBe("inner")
  })

  test("SessionState.get() with no arg reads sessionId from FiberRef", async () => {
    const program = withSession(
      "fiber-sid",
      Effect.gen(function* () {
        const s = yield* SessionState
        // Pre-seed via explicit form
        yield* s.update("fiber-sid", { verification_status: "passed" })
        // Read via no-arg form (FiberRef path)
        return yield* s.get()
      }),
    ).pipe(Effect.provide(SessionStateTest()))
    const r = await Effect.runPromise(program)
    expect(r.verification_status).toBe("passed")
  })

  test("SessionState.get() without FiberRef fails with FsError", async () => {
    const program = Effect.gen(function* () {
      const s = yield* SessionState
      return yield* s.get()
    }).pipe(Effect.provide(SessionStateTest()))
    const result = await Effect.runPromiseExit(program)
    expect(result._tag).toBe("Failure")
  })
})
