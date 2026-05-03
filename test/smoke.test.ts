import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

describe("smoke", () => {
  test("Effect.runSync returns the wrapped value", () => {
    expect(Effect.runSync(Effect.succeed(1))).toBe(1)
  })
})
