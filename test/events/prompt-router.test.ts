import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { handleUserPromptSubmit } from "../../src/events/prompt-router.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { SessionStateTest } from "../../src/services/session-state.ts"
import {
  WORKFLOW_TAGS,
  type WorkflowTag,
  classifyPrompt,
} from "../../src/policies/workflow-classifier.ts"
import { ClaudeSubprocessTest } from "../../src/services/claude-subprocess.ts"
import { InferenceTest, FAIL_SAFE } from "../../src/services/inference.ts"
import { ClassifierTelemetryTest } from "../../src/services/classifier-telemetry.ts"

const inferenceLayer = InferenceTest(() => ({
  ...FAIL_SAFE,
  reason: "test default → ALGORITHM E3",
  latencyMs: 0,
}))
const subprocLayer = ClaudeSubprocessTest()

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const samplePromptForTag = (tag: WorkflowTag): string => {
  switch (tag) {
    case "coding.fix": return "Fix the bug"
    case "coding.feature": return "Implement a new feature"
    case "coding.refactor": return "Refactor this module"
    case "coding.review": return "Review this PR"
    case "coding.test": return "Add unit tests"
    case "coding.perf": return "Optimize performance of this query"
    case "coding.security": return "Audit for security vulnerabilities"
    case "research.web": return "Search the web for best practices"
    case "research.repo": return "Where in the codebase is this handled?"
    case "research.synthesis": return "Compare the trade-offs"
    case "writing.doc": return "Write the README"
    case "ops.git": return "Squash commits and rebase"
    case "ops.deploy": return "Deploy to production"
    case "ops.migration": return "Run the migration"
    case "unknown": return "asdf qwer zxcv"
  }
}

describe("handleUserPromptSubmit", () => {
  for (const tag of WORKFLOW_TAGS) {
    test(`classifies prompt for ${tag}`, async () => {
      const payload = decode({
        _tag: "UserPromptSubmit",
        session_id: "s",
        hook_event_name: "UserPromptSubmit",
        prompt: samplePromptForTag(tag),
      })
      const d = await Effect.runPromise(
        handleUserPromptSubmit(payload).pipe(
          Effect.provide(SessionStateTest()),
          Effect.provide(inferenceLayer),
          Effect.provide(subprocLayer),
          Effect.provide(ClassifierTelemetryTest().layer),
        ),
      )
      const out = d as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string }
      }
      expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
      expect(out.hookSpecificOutput.additionalContext).toContain(`Detected workflow: ${tag}`)
      expect(out.hookSpecificOutput.additionalContext).toContain(
        classifyPrompt(samplePromptForTag(tag)).playbook,
      )
    })
  }

  test("ALGORITHM tier ≥ 3 → emits ISA engagement directive with deterministic path", async () => {
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "abc-123",
      hook_event_name: "UserPromptSubmit",
      prompt: "implement a log-analysis CLI in TypeScript with three subcommands",
    })
    const d = await Effect.runPromise(
      handleUserPromptSubmit(payload).pipe(
        Effect.provide(SessionStateTest()),
        Effect.provide(inferenceLayer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
      ),
    )
    const ctx = (
      d as { hookSpecificOutput: { additionalContext: string } }
    ).hookSpecificOutput.additionalContext
    expect(ctx).toContain("ENGAGE: ALGORITHM_ENGAGEMENT_REQUIRED=true")
    expect(ctx).toContain("ISA_PATH=.claude-hooks/state/work/abc-123/ISA.md")
    expect(ctx).toContain("MANDATORY FIRST ACTION")
    expect(ctx).toContain("Required sections for E3:")
    expect(ctx).toContain("Problem")
    expect(ctx).toContain("Out of Scope")
    expect(ctx).toContain("Test Strategy")
    expect(ctx).toContain("absence is treated as failure")
  })

  test("ALGORITHM E4 → directive lists all twelve sections", async () => {
    const e4Layer = InferenceTest(() => ({
      mode: "ALGORITHM",
      tier: 4,
      reason: "test e4",
      source: "classifier",
      latencyMs: 0,
    }))
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "deep-1",
      hook_event_name: "UserPromptSubmit",
      prompt: "rearchitect the dispatcher to support sharded handlers",
    })
    const d = await Effect.runPromise(
      handleUserPromptSubmit(payload).pipe(
        Effect.provide(SessionStateTest()),
        Effect.provide(e4Layer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
      ),
    )
    const ctx = (
      d as { hookSpecificOutput: { additionalContext: string } }
    ).hookSpecificOutput.additionalContext
    expect(ctx).toContain("Required sections for E4:")
    for (const s of [
      "Problem",
      "Vision",
      "Out of Scope",
      "Principles",
      "Constraints",
      "Goal",
      "Criteria",
      "Test Strategy",
      "Features",
      "Decisions",
      "Changelog",
      "Verification",
    ]) {
      expect(ctx).toContain(s)
    }
  })

  test("ALGORITHM tier ≥ 3 → writes engagement bookkeeping to SessionState", async () => {
    const { SessionState } = await import(
      "../../src/services/session-state.ts"
    )
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "track-me",
      hook_event_name: "UserPromptSubmit",
      prompt: "build the thing",
    })
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleUserPromptSubmit(payload)
        const s = yield* SessionState
        return yield* s.get("track-me")
      }).pipe(
        Effect.provide(SessionStateTest()),
        Effect.provide(inferenceLayer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
      ),
    )
    expect(record.engagement_required).toBe(true)
    expect(record.last_mode).toBe("ALGORITHM")
    expect(record.last_tier).toBe(3)
    expect(record.expected_isa_path).toBe(
      ".claude-hooks/state/work/track-me/ISA.md",
    )
  })

  test("MINIMAL → engagement_required stays false in SessionState", async () => {
    const { SessionState } = await import(
      "../../src/services/session-state.ts"
    )
    const minimalLayer = InferenceTest(() => ({
      mode: "MINIMAL",
      tier: null,
      reason: "test minimal",
      source: "classifier",
      latencyMs: 0,
    }))
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "untracked",
      hook_event_name: "UserPromptSubmit",
      prompt: "thanks",
    })
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleUserPromptSubmit(payload)
        const s = yield* SessionState
        return yield* s.get("untracked")
      }).pipe(
        Effect.provide(SessionStateTest()),
        Effect.provide(minimalLayer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
      ),
    )
    expect(record.engagement_required).toBe(false)
    expect(record.last_mode).toBe("MINIMAL")
    expect(record.expected_isa_path).toBe(null)
  })

  test("MINIMAL → no ISA engagement directive", async () => {
    const minimalLayer = InferenceTest(() => ({
      mode: "MINIMAL",
      tier: null,
      reason: "test minimal",
      source: "classifier",
      latencyMs: 0,
    }))
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "s",
      hook_event_name: "UserPromptSubmit",
      prompt: "thanks",
    })
    const d = await Effect.runPromise(
      handleUserPromptSubmit(payload).pipe(
        Effect.provide(SessionStateTest()),
        Effect.provide(minimalLayer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
      ),
    )
    const ctx = (
      d as { hookSpecificOutput: { additionalContext: string } }
    ).hookSpecificOutput.additionalContext
    expect(ctx).not.toContain("ENGAGE")
  })

  test("ALGORITHM tier 2 → no ISA engagement directive", async () => {
    const tier2Layer = InferenceTest(() => ({
      mode: "ALGORITHM",
      tier: 2,
      reason: "test tier 2",
      source: "classifier",
      latencyMs: 0,
    }))
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "s",
      hook_event_name: "UserPromptSubmit",
      prompt: "rename foo to bar in this file",
    })
    const d = await Effect.runPromise(
      handleUserPromptSubmit(payload).pipe(
        Effect.provide(SessionStateTest()),
        Effect.provide(tier2Layer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
      ),
    )
    const ctx = (
      d as { hookSpecificOutput: { additionalContext: string } }
    ).hookSpecificOutput.additionalContext
    expect(ctx).not.toContain("ENGAGE")
  })

  test("non-UserPromptSubmit payload → SAFE_DEFAULT", async () => {
    const payload = decode({
      _tag: "Stop",
      session_id: "s",
      hook_event_name: "Stop",
    })
    const d = await Effect.runPromise(
      handleUserPromptSubmit(payload).pipe(
        Effect.provide(SessionStateTest()),
        Effect.provide(inferenceLayer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
      ),
    )
    expect(d).toEqual({})
  })
})
