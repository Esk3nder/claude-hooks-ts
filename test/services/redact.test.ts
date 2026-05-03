import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Redact, RedactLive } from "../../src/services/redact.ts"

describe("Redact (cached patterns)", () => {
  test("redacts known secret patterns", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const r = yield* Redact
        return yield* r.redact("token=sk-abcdefghij1234567890ZZZZ rest")
      }).pipe(Effect.provide(RedactLive)),
    )
    expect(out).toContain("[REDACTED]")
    expect(out).toContain("rest")
  })

  test("containsSecret detects patterns", async () => {
    const yes = await Effect.runPromise(
      Effect.gen(function* () {
        const r = yield* Redact
        return yield* r.containsSecret("ghp_abcdefghij1234567890ZZZZ12345xyz")
      }).pipe(Effect.provide(RedactLive)),
    )
    const no = await Effect.runPromise(
      Effect.gen(function* () {
        const r = yield* Redact
        return yield* r.containsSecret("nothing to see here")
      }).pipe(Effect.provide(RedactLive)),
    )
    expect(yes).toBe(true)
    expect(no).toBe(false)
  })

  test("microbench: 10k redact calls under 50ms (cache works)", async () => {
    const sample = "hello world, no secrets here, just text"
    const t0 = performance.now()
    await Effect.runPromise(
      Effect.gen(function* () {
        const r = yield* Redact
        for (let i = 0; i < 10000; i++) {
          yield* r.redact(sample)
        }
      }).pipe(Effect.provide(RedactLive)),
    )
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(50)
  })
})
