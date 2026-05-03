import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { handleUserPromptSubmit } from "../../src/events/prompt-router.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import {
  WORKFLOW_TAGS,
  type WorkflowTag,
  classifyPrompt,
} from "../../src/policies/workflow-classifier.ts"

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
      const d = await Effect.runPromise(handleUserPromptSubmit(payload))
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
    const d = await Effect.runPromise(handleUserPromptSubmit(payload))
    expect(d).toEqual({})
  })
})
