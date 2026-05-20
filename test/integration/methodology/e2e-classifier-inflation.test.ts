/**
 * Methodology pillar: right-sized ceremony — inflation guard.
 *
 * The Sonnet rubric biases UP. US-3 floors over-classified verdicts to
 * E3 when the prompt and recent context show no structural evidence.
 * This test runs the real Inference.classify through a mocked Sonnet
 * subprocess and asserts the floor lands.
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

describe("methodology e2e: classifier inflation (US-3)", () => {
  test("wall-of-text prompt classified E5 by Sonnet → floored to E3", async () => {
    // Sonnet returns tier 5; the prompt is verbose prose with no code,
    // no file paths, no structural verbs, no ISA refs.
    const c = await runClassify(
      `{"mode":"ALGORITHM","tier":5,"mode_reason":"feels comprehensive"}`,
      "Please carefully consider all the implications of this work. " +
        "Think about every angle. Be thorough. Be deliberate. Take your time. " +
        "We want the highest quality possible. No shortcuts. No corner-cutting.",
    )
    expect(c.mode).toBe("ALGORITHM")
    expect(c.tier).toBe(3)
    expect(c.reason).toContain("inflation-guard")
  })

  test("E4 prompt with code fence is KEPT at E4 (real structural evidence)", async () => {
    const c = await runClassify(
      `{"mode":"ALGORITHM","tier":4,"mode_reason":"architecture review"}`,
      "redesign:\n```ts\nfunction handler() { /* ... */ }\n```",
    )
    expect(c.mode).toBe("ALGORITHM")
    expect(c.tier).toBe(4)
    expect(c.reason).not.toContain("inflation-guard")
  })

  test("E3 verdict is NEVER touched (only E4+ are candidates)", async () => {
    const c = await runClassify(
      `{"mode":"ALGORITHM","tier":3,"mode_reason":"multi-file refactor"}`,
      "do it",
    )
    expect(c.tier).toBe(3)
    expect(c.reason).not.toContain("inflation-guard")
  })
})
