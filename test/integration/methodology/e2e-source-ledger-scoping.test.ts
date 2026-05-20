/**
 * Methodology pillar: right-sized ceremony — workflow-scoped source-ledger (US-4).
 *
 * The source-ledger Stop gate previously fired on any prompt containing
 * "current best practices" or similar weak idioms. US-4 scopes that
 * decision by the workflow tag: WEAK patterns are suppressed on
 * confidently coding/writing/ops tagged turns. STRONG patterns
 * ("cite the sources", "search the web") still fire.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { handleUserPromptSubmit } from "../../../src/events/prompt-router.ts"
import { ClassifierTelemetryTest } from "../../../src/services/classifier-telemetry.ts"
import { ClaudeSubprocessTest } from "../../../src/services/claude-subprocess.ts"
import { CommandRunnerTest } from "../../../src/services/command-runner.ts"
import { InferenceTest, FAIL_SAFE } from "../../../src/services/inference.ts"
import { SessionState, SessionStateTest } from "../../../src/services/session-state.ts"
import { decodePayload } from "./_helpers.ts"

const NOOP_INFERENCE = InferenceTest(() => ({
  ...FAIL_SAFE,
  reason: "fixture",
  latencyMs: 0,
}))

const runAndRead = async (sessionId: string, prompt: string) => {
  const payload = decodePayload({
    _tag: "UserPromptSubmit",
    session_id: sessionId,
    hook_event_name: "UserPromptSubmit",
    prompt,
  })
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* handleUserPromptSubmit(payload)
      const s = yield* SessionState
      return yield* s.get(sessionId)
    }).pipe(
      Effect.provide(SessionStateTest()),
      Effect.provide(NOOP_INFERENCE),
      Effect.provide(ClaudeSubprocessTest()),
      Effect.provide(ClassifierTelemetryTest().layer),
      Effect.provide(CommandRunnerTest()),
    ),
  )
}

describe("methodology e2e: source-ledger workflow scoping (US-4)", () => {
  test("WEAK pattern + coding workflow → requires_web_sources=false (no Stop block)", async () => {
    const r = await runAndRead(
      "scope-coding",
      "current best practices for error handling",
    )
    expect(r.last_workflow).toBe("coding.fix")
    expect(r.requires_web_sources).toBe(false)
  })

  test("STRONG pattern + coding workflow → requires_web_sources=true (still fires)", async () => {
    const r = await runAndRead(
      "scope-strong",
      "build a feature and cite the sources at the bottom",
    )
    expect(r.last_workflow).toBe("coding.feature")
    expect(r.requires_web_sources).toBe(true)
  })

  test("WEAK pattern + unknown workflow → requires_web_sources=true (belt-and-suspenders)", async () => {
    const r = await runAndRead(
      "scope-unknown",
      "current best practices",
    )
    expect(r.last_workflow).toBe("unknown")
    expect(r.requires_web_sources).toBe(true)
  })
})
