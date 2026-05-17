import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SAFE_DEFAULT } from "../../src/schema/decisions.ts"
import {
  HookFailureTest,
  redactFailureContext,
  reportHookFailure,
} from "../../src/services/hook-failure.ts"

describe("HookFailure reporting", () => {
  test("captures typed failure records with fallback, annotations context, and redaction", async () => {
    const hookFailures = HookFailureTest()

    await Effect.runPromise(
      reportHookFailure({
        kind: "handler_timeout",
        event: "PreToolUse",
        sessionId: "sess-1",
        cause: new Error("handler took too long"),
        fallbackDecision: SAFE_DEFAULT,
        hookSafe: true,
        context: {
          cwd: "/repo",
          tool_name: "Bash",
          api_key: "super-secret",
          nested: { value: 1 },
        },
      }).pipe(Effect.provide(hookFailures.layer)),
    )

    const records = hookFailures.records()
    expect(records).toHaveLength(1)
    const record = records[0]
    if (record === undefined) throw new Error("missing hook failure record")
    expect(record.kind).toBe("handler_timeout")
    expect(record.event).toBe("PreToolUse")
    expect(record.sessionId).toBe("sess-1")
    expect(record.hookSafe).toBe(true)
    expect(record.fallbackDecision).toEqual({})
    expect(record.cause).toContain("handler took too long")
    expect(record.context["cwd"]).toBe("/repo")
    expect(record.context["tool_name"]).toBe("Bash")
    expect(record.context["api_key"]).toBe("[REDACTED]")
    expect(record.context["nested"]).toBe('{"value":1}')
  })

  test("redacts secret-looking context keys", () => {
    expect(
      redactFailureContext({ token: "t", password: "p", cwd: "/safe" }),
    ).toEqual({ token: "[REDACTED]", password: "[REDACTED]", cwd: "/safe" })
  })

  test("does not serialize arbitrary object causes into diagnostics", async () => {
    const hookFailures = HookFailureTest()

    await Effect.runPromise(
      reportHookFailure({
        kind: "payload_decode_failed",
        event: "PreToolUse",
        sessionId: "sess-object-cause",
        cause: {
          prompt: "TOP_SECRET_PROMPT",
          tool_input: { command: "cat .env" },
        },
        hookSafe: true,
      }).pipe(Effect.provide(hookFailures.layer)),
    )

    const record = hookFailures.records()[0]
    if (record === undefined) throw new Error("missing hook failure record")
    expect(record.cause).toBe("non-error object cause")
    expect(record.cause).not.toContain("TOP_SECRET_PROMPT")
    expect(record.cause).not.toContain("tool_input")
  })

  test("redacts known secret values from string causes", async () => {
    const hookFailures = HookFailureTest()

    await Effect.runPromise(
      reportHookFailure({
        kind: "handler_failed",
        event: "Stop",
        sessionId: "sess-string-cause",
        cause: "failed with sk-123456789012345678901234567890",
        hookSafe: true,
      }).pipe(Effect.provide(hookFailures.layer)),
    )

    const record = hookFailures.records()[0]
    if (record === undefined) throw new Error("missing hook failure record")
    expect(record.cause).toContain("[REDACTED]")
    expect(record.cause).not.toContain("sk-123456789012345678901234567890")
  })
})
