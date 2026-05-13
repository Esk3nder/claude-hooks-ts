import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { handlePostToolUseFailure } from "../../src/events/failure-explainer.ts"
import { HookPayload } from "../../src/schema/payloads.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const failurePayload = (error: unknown) =>
  decode({
    _tag: "PostToolUseFailure",
    session_id: "s",
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command: "pytest" },
    error,
  })

describe("VAL-M4-001 failure-explainer", () => {
  test("pytest failure → ContextInjection under 800 chars", async () => {
    const text = `============================= FAILURES =============================
test/test_foo.py::test_add FAILED
E       AssertionError: assert 2 == 3
test/test_foo.py:14: AssertionError
FAILED test/test_foo.py::test_add - AssertionError: assert 2 == 3
`
    const d = await Effect.runPromise(handlePostToolUseFailure(failurePayload(text)))
    expect("hookSpecificOutput" in d).toBe(true)
    if ("hookSpecificOutput" in d) {
      const ac = (d.hookSpecificOutput as { additionalContext: string }).additionalContext
      expect(ac.length).toBeLessThan(800)
      expect(ac).toContain("pytest")
      expect(ac).toContain("test_foo.py")
    }
  })

  test("massive error blob is truncated to <800 chars", async () => {
    const big = "error TS2322: " + "x".repeat(5000) + " src/foo.ts:1:1"
    const d = await Effect.runPromise(handlePostToolUseFailure(failurePayload(big)))
    if ("hookSpecificOutput" in d) {
      const ac = (d.hookSpecificOutput as { additionalContext: string }).additionalContext
      expect(ac.length).toBeLessThan(800)
    }
  })

  test("empty error → NO_DECISION", async () => {
    const d = await Effect.runPromise(handlePostToolUseFailure(failurePayload("")))
    expect(d).toEqual({})
  })

  test("error object with .message is parsed", async () => {
    const d = await Effect.runPromise(
      handlePostToolUseFailure(
        failurePayload({ message: "error TS2322: bad type at src/x.ts:5:1" }),
      ),
    )
    if ("hookSpecificOutput" in d) {
      const ac = (d.hookSpecificOutput as { additionalContext: string }).additionalContext
      expect(ac).toContain("tsc")
    }
  })

  test("redacts known secret values from failure summaries", async () => {
    const d = await Effect.runPromise(
      handlePostToolUseFailure(
        failurePayload(
          "error TS2322: failed with sk-123456789012345678901234567890 at src/secret.ts:1:1",
        ),
      ),
    )
    if ("hookSpecificOutput" in d) {
      const ac = (d.hookSpecificOutput as { additionalContext: string }).additionalContext
      expect(ac).toContain("[REDACTED]")
      expect(ac).not.toContain("sk-123456789012345678901234567890")
    }
  })

  test("does not stringify arbitrary error objects", async () => {
    const d = await Effect.runPromise(
      handlePostToolUseFailure(
        failurePayload({ prompt: "TOP_SECRET_PROMPT", tool_input: { command: "cat .env" } }),
      ),
    )
    expect(d).toEqual({})
  })
})
