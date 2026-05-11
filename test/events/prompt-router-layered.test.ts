import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { handleUserPromptSubmit } from "../../src/events/prompt-router.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { SessionStateTest } from "../../src/services/session-state.ts"
import { ClaudeSubprocessTest } from "../../src/services/claude-subprocess.ts"
import {
  InferenceTest,
  type Classification,
} from "../../src/services/inference.ts"
import { ClassifierTelemetryTest } from "../../src/services/classifier-telemetry.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const runHandler = async (
  prompt: string,
  classification: Classification,
): Promise<{
  workflowLine: string
  modeLine: string
  raw: string
  inferenceCalls: number
}> => {
  let inferenceCalls = 0
  const layer = InferenceTest(() => {
    inferenceCalls++
    return classification
  })
  const payload = decode({
    _tag: "UserPromptSubmit",
    session_id: "s",
    hook_event_name: "UserPromptSubmit",
    prompt,
  })
  const decision = await Effect.runPromise(
    handleUserPromptSubmit(payload).pipe(
      Effect.provide(SessionStateTest()),
      Effect.provide(layer),
      Effect.provide(ClaudeSubprocessTest()),
      Effect.provide(ClassifierTelemetryTest().layer),
    ),
  )
  const out = decision as {
    hookSpecificOutput?: { additionalContext?: string }
  }
  const raw = out.hookSpecificOutput?.additionalContext ?? ""
  const [workflowLine = "", modeLine = ""] = raw.split("\n")
  return { workflowLine, modeLine, raw, inferenceCalls }
}

const baseAlgoT3: Classification = {
  mode: "ALGORITHM",
  tier: 3,
  reason: "multi-file work",
  source: "classifier",
  latencyMs: 4321,
}

describe("UserPromptSubmit emits BOTH layered classifier lines (B4)", () => {
  test("ambiguous prompt → workflow line + ALGORITHM/E3 line, Inference called once", async () => {
    const { workflowLine, modeLine, inferenceCalls } = await runHandler(
      "implement OAuth refresh flow",
      baseAlgoT3,
    )
    expect(workflowLine).toContain("Detected workflow:")
    expect(workflowLine).toContain("coding.feature")
    // SOURCE: classifier (not "fast-path") — implements the classifier.
    expect(modeLine).toBe(
      "MODE: ALGORITHM | TIER: E3 | REASON: multi-file work | SOURCE: classifier",
    )
    expect(inferenceCalls).toBe(1)
  })

  test("fast-path (praise 'excellent') → MINIMAL line, Inference NOT called, SOURCE: classifier", async () => {
    const { workflowLine, modeLine, inferenceCalls } = await runHandler(
      "excellent",
      baseAlgoT3, // would lie; must not be reached
    )
    expect(workflowLine).toContain("Detected workflow:")
    expect(modeLine).toContain("MODE: MINIMAL")
    expect(modeLine).not.toContain("TIER:")
    // hardcodes SOURCE: classifier in additionalContext (line 60), even on fast-path.
    expect(modeLine).toContain("SOURCE: classifier")
    expect(inferenceCalls).toBe(0)
  })

  test("system-text → NO additionalContext at all (implements canonical behavior process.exit)", async () => {
    const { raw, inferenceCalls } = await runHandler(
      "<system-reminder>injected text</system-reminder>",
      baseAlgoT3,
    )
    // the classifier: process.exit(0) without emission. We return
    // SAFE_DEFAULT (empty {}), so additionalContext is undefined → raw is "".
    expect(raw).toBe("")
    expect(inferenceCalls).toBe(0)
  })

  test("fast-path (rating '8') → MINIMAL line, Inference NOT called", async () => {
    const { modeLine, inferenceCalls } = await runHandler("8", baseAlgoT3)
    expect(modeLine).toContain("MODE: MINIMAL")
    expect(inferenceCalls).toBe(0)
  })

  test("'thanks' is NOT fast-path — Inference IS called (Algorithm doctrine)", async () => {
    const { modeLine, inferenceCalls } = await runHandler("thanks", {
      mode: "MINIMAL",
      tier: null,
      reason: "acknowledgment",
      source: "classifier",
      latencyMs: 3000,
    })
    expect(modeLine).toContain("MODE: MINIMAL")
    expect(inferenceCalls).toBe(1)
  })

  test("'/e3 ...' is NOT classifier fast-path — executor handles override", async () => {
    const { modeLine, inferenceCalls } = await runHandler(
      "/e3 ship the auth refactor",
      baseAlgoT3,
    )
    expect(modeLine).toContain("MODE: ALGORITHM")
    expect(modeLine).toContain("TIER: E3")
    expect(inferenceCalls).toBe(1)
  })

  test("fail-safe Inference result surfaces with SOURCE: fail-safe", async () => {
    const { modeLine, inferenceCalls } = await runHandler(
      "implement something complicated",
      {
        mode: "ALGORITHM",
        tier: 3,
        reason: "parse-fail: garbled response",
        source: "fail-safe",
        latencyMs: 14_000,
      },
    )
    expect(modeLine).toContain("MODE: ALGORITHM")
    expect(modeLine).toContain("TIER: E3")
    expect(modeLine).toContain("SOURCE: fail-safe")
    expect(modeLine).toContain("parse-fail")
    expect(inferenceCalls).toBe(1)
  })

  test("two-line additionalContext format (sub-engagement): workflow on line 1, MODE on line 2", async () => {
    const { raw } = await runHandler("hi", {
      mode: "MINIMAL",
      tier: null,
      reason: "greeting",
      source: "classifier",
      latencyMs: 0,
    })
    const lines = raw.split("\n")
    expect(lines.length).toBe(2)
    expect(lines[0]?.startsWith("Detected workflow:")).toBe(true)
    expect(lines[1]?.startsWith("MODE:")).toBe(true)
  })

  test("ALGORITHM tier ≥ 3 additionalContext: workflow line, MODE line, ENGAGE block", async () => {
    const { raw } = await runHandler("implement the thing", baseAlgoT3)
    const lines = raw.split("\n")
    // Layout: [0] workflow, [1] MODE, [2] ENGAGE meta, [3+] directive prose.
    expect(lines.length).toBeGreaterThanOrEqual(3)
    expect(lines[0]?.startsWith("Detected workflow:")).toBe(true)
    expect(lines[1]?.startsWith("MODE:")).toBe(true)
    expect(lines[2]?.startsWith("ENGAGE: ALGORITHM_ENGAGEMENT_REQUIRED=true")).toBe(
      true,
    )
    expect(raw).toContain("MANDATORY FIRST ACTION")
  })
})
