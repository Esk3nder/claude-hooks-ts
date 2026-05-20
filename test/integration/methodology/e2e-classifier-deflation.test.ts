/**
 * Methodology pillar: right-sized ceremony — classifier DEFLATION guard
 * (US-3c, symmetric counterpart to the inflation guard in US-3).
 *
 * The promise: when Sonnet returns MINIMAL or NATIVE but the prompt or
 * recent context contains structural signals (code fences, ≥3 file
 * paths, structural verbs, ISA refs), the classification is escalated
 * to ALGORITHM E1 — never higher than that, because E3+ would be
 * over-correction.
 *
 * Deferred when the integration suite first landed (PR #60) because
 * US-3c had not yet merged. Now that US-3c is on `main` (PR #59), this
 * test completes the 8th fixture in the suite. (The 9th —
 * `e2e-spec-drift.test.ts` — still awaits US-15.)
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  Inference,
  InferenceLive,
  type Classification,
} from "../../../src/services/inference.ts"
import {
  ClaudeSubprocessTest,
  type ClaudeSpawnResult,
} from "../../../src/services/claude-subprocess.ts"

const runClassify = (stdout: string, prompt: string): Promise<Classification> => {
  const result: ClaudeSpawnResult = {
    stdout,
    stderr: "",
    exitCode: 0,
    latencyMs: 100,
    timedOut: false,
  }
  const program = Effect.gen(function* () {
    const inf = yield* Inference
    return yield* inf.classify(prompt)
  })
  return Effect.runPromise(
    program.pipe(
      Effect.provide(InferenceLive),
      Effect.provide(ClaudeSubprocessTest(() => result)),
    ),
  )
}

describe("methodology e2e: classifier deflation (US-3c)", () => {
  test("MINIMAL + ≥3 file paths in prompt → escalated to ALGORITHM E1", async () => {
    const c = await runClassify(
      `{"mode":"MINIMAL","tier":null,"mode_reason":"ack"}`,
      "touch src/a.ts, src/b.ts, and src/c.ts",
    )
    expect(c.mode).toBe("ALGORITHM")
    expect(c.tier).toBe(1)
    expect(c.reason).toContain("deflation-guard")
  })

  test("NATIVE + code fence in prompt → escalated to ALGORITHM E1", async () => {
    const c = await runClassify(
      `{"mode":"NATIVE","tier":null,"mode_reason":"single edit"}`,
      "rewrite this:\n```ts\nconst x = 1\n```",
    )
    expect(c.mode).toBe("ALGORITHM")
    expect(c.tier).toBe(1)
  })

  test("MINIMAL ack with NO structural signal → untouched (true negative)", async () => {
    const c = await runClassify(
      `{"mode":"MINIMAL","tier":null,"mode_reason":"ack"}`,
      "thanks",
    )
    expect(c.mode).toBe("MINIMAL")
    expect(c.tier).toBe(null)
    expect(c.reason).not.toContain("deflation-guard")
  })

  test("ALGORITHM tier 3 left untouched (deflation only fires on MINIMAL/NATIVE)", async () => {
    const c = await runClassify(
      `{"mode":"ALGORITHM","tier":3,"mode_reason":"normal"}`,
      "do it",
    )
    expect(c.mode).toBe("ALGORITHM")
    expect(c.tier).toBe(3)
    expect(c.reason).not.toContain("deflation-guard")
  })

  test("never escalates above tier 1 even with very rich evidence", async () => {
    const c = await runClassify(
      `{"mode":"MINIMAL","tier":null,"mode_reason":"ack"}`,
      "multi-step refactor:\n```ts\nfn()\n```\nacross src/a.ts, src/b.ts, src/c.ts",
    )
    expect(c.mode).toBe("ALGORITHM")
    expect(c.tier).toBe(1)
  })
})
