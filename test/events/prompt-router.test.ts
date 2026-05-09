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
