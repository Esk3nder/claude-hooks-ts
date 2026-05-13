import { describe, expect, test } from "bun:test"
import { encodeDecisionForStdout } from "../src/dispatcher.ts"

describe("dispatcher decision validation", () => {
  test("invalid non-raw decision logs decision_encode_failed and emits JSON fallback", () => {
    const rendered = encodeDecisionForStdout({ continue: false } as never)

    expect(rendered.encodeFailed).toBe(true)
    expect(JSON.parse(rendered.stdout)).toEqual({})
  })

  test("invalid PreToolUse decision falls back to hook-safe ask", () => {
    const rendered = encodeDecisionForStdout({ continue: false } as never, {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason:
          "Malformed PreToolUse payload could not be decoded; asking for confirmation instead of allowing tool execution.",
      },
    })
    const parsed = JSON.parse(rendered.stdout)

    expect(rendered.encodeFailed).toBe(true)
    expect(parsed.hookSpecificOutput?.hookEventName).toBe("PreToolUse")
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("ask")
  })
})
