import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { handlePreToolUse } from "../../src/events/pretool-policy.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import {
  shouldRewrite,
  rewriteTestCommand,
  hasPipeOrRedirect,
  isTestLikeCommand,
} from "../../src/policies/test-output-rewrite.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const preBash = (command: string) =>
  decode({
    _tag: "PreToolUse",
    session_id: "s",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  })

describe("test-output-rewrite policy (VAL-M5-002)", () => {
  test("isTestLikeCommand recognises common runners", () => {
    expect(isTestLikeCommand("npm test")).toBe(true)
    expect(isTestLikeCommand("bun test")).toBe(true)
    expect(isTestLikeCommand("pnpm test")).toBe(true)
    expect(isTestLikeCommand("yarn test")).toBe(true)
    expect(isTestLikeCommand("jest")).toBe(true)
    expect(isTestLikeCommand("vitest")).toBe(true)
    expect(isTestLikeCommand("pytest")).toBe(true)
    expect(isTestLikeCommand("cargo test")).toBe(true)
    expect(isTestLikeCommand("go test ./...")).toBe(true)
    expect(isTestLikeCommand("make test")).toBe(true)
    expect(isTestLikeCommand("npm run build")).toBe(true)
    expect(isTestLikeCommand("ls")).toBe(false)
    expect(isTestLikeCommand("git status")).toBe(false)
  })

  test("hasPipeOrRedirect detects | grep / | head / > redirect", () => {
    expect(hasPipeOrRedirect("npm test | grep FAIL")).toBe(true)
    expect(hasPipeOrRedirect("npm test | head -50")).toBe(true)
    expect(hasPipeOrRedirect("npm test > out.log")).toBe(true)
    expect(hasPipeOrRedirect("npm test &> out.log")).toBe(true)
    expect(hasPipeOrRedirect("npm test")).toBe(false)
    // 2>&1 alone is not a redirect to file
    expect(hasPipeOrRedirect("npm test 2>&1")).toBe(false)
  })

  test("shouldRewrite is true only for unfiltered test commands", () => {
    expect(shouldRewrite("npm test")).toBe(true)
    expect(shouldRewrite("npm test | head")).toBe(false)
    expect(shouldRewrite("ls")).toBe(false)
  })

  test("rewriteTestCommand wraps with failure-only filter", () => {
    const out = rewriteTestCommand("npm test")
    expect(out).toContain("npm test")
    expect(out).toContain("2>&1")
    expect(out).toContain("grep")
    expect(out).toContain("head -200")
    expect(out).toMatch(/FAIL/)
  })

  test("PreToolUse Bash 'npm test' returns updatedInput with rewritten command", async () => {
    const d = await Effect.runPromise(handlePreToolUse(preBash("npm test")))
    const out = d as {
      hookSpecificOutput?: {
        permissionDecision?: string
        updatedInput?: { command?: string }
      }
    }
    expect(out.hookSpecificOutput?.permissionDecision).toBe("allow")
    expect(out.hookSpecificOutput?.updatedInput?.command).toContain("grep")
    expect(out.hookSpecificOutput?.updatedInput?.command).toContain("head -200")
  })

  test("PreToolUse Bash already-piped command is left alone (no updatedInput)", async () => {
    const d = await Effect.runPromise(
      handlePreToolUse(preBash("npm test | head -50")),
    )
    const out = d as {
      hookSpecificOutput?: { updatedInput?: unknown }
    }
    expect(out.hookSpecificOutput?.updatedInput).toBeUndefined()
  })

  test("PreToolUse Bash non-test command unchanged", async () => {
    const d = await Effect.runPromise(handlePreToolUse(preBash("ls -la")))
    expect(d).toEqual({})
  })

  test("PreToolUse Bash destructive command still denied (rewrite does not override)", async () => {
    const d = await Effect.runPromise(handlePreToolUse(preBash("rm -rf /")))
    const out = d as {
      hookSpecificOutput?: { permissionDecision?: string }
    }
    expect(["deny", "ask"]).toContain(
      out.hookSpecificOutput?.permissionDecision ?? "",
    )
  })
})
