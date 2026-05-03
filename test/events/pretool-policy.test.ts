import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { handlePreToolUse } from "../../src/events/pretool-policy.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { PreToolUseDecision } from "../../src/schema/decisions.ts"

const payload = (toolName: string, toolInput: unknown) => {
  const raw = {
    _tag: "PreToolUse",
    session_id: "s",
    transcript_path: "/tmp/t",
    cwd: "/tmp",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
  }
  return Schema.decodeUnknownSync(HookPayload)(raw)
}

const run = async (toolName: string, toolInput: unknown) => {
  const result = await Effect.runPromise(handlePreToolUse(payload(toolName, toolInput)))
  return result as Record<string, unknown>
}

const expectDecision = (
  d: Record<string, unknown>,
  kind: "allow" | "deny" | "ask",
) => {
  Schema.decodeUnknownSync(PreToolUseDecision)(d)
  const inner = (d as { hookSpecificOutput: { permissionDecision: string } })
    .hookSpecificOutput
  expect(inner.permissionDecision).toBe(kind)
}

describe("handlePreToolUse — red-team M2 assertions", () => {
  // VAL-M2-001
  test("VAL-M2-001: Read .env → deny", async () => {
    const d = await run("Read", { file_path: "/Users/x/proj/.env" })
    expectDecision(d, "deny")
  })

  // VAL-M2-002
  test("VAL-M2-002: Bash rm -rf /tmp/x → ask or deny", async () => {
    const d = await run("Bash", { command: "rm -rf /tmp/x" })
    const inner = (d as { hookSpecificOutput: { permissionDecision: string } })
      .hookSpecificOutput
    expect(["ask", "deny"]).toContain(inner.permissionDecision)
  })
  test("VAL-M2-002: Bash git reset --hard → deny", async () => {
    const d = await run("Bash", { command: "git reset --hard HEAD" })
    expectDecision(d, "deny")
  })
  test("VAL-M2-002: Bash sudo rm → deny", async () => {
    const d = await run("Bash", { command: "sudo rm -rf /var/log/foo" })
    expectDecision(d, "deny")
  })
  test("VAL-M2-002: Bash git clean -fdx → deny", async () => {
    const d = await run("Bash", { command: "git clean -fdx" })
    expectDecision(d, "deny")
  })
  test("VAL-M2-002: Bash drop database → deny", async () => {
    const d = await run("Bash", { command: "psql -c 'DROP DATABASE prod'" })
    expectDecision(d, "deny")
  })
  test("VAL-M2-002: Bash terraform destroy → deny", async () => {
    const d = await run("Bash", { command: "terraform destroy -auto-approve" })
    expectDecision(d, "deny")
  })

  // VAL-M2-003
  test("VAL-M2-003: Edit ~/.claude/settings.json → ask", async () => {
    const d = await run("Edit", {
      file_path: "/Users/x/.claude/settings.json",
      old_string: "a",
      new_string: "b",
    })
    expectDecision(d, "ask")
  })
  test("VAL-M2-003: Write .claude/hooks/foo.mjs → ask", async () => {
    const d = await run("Write", {
      file_path: "/repo/.claude/hooks/foo.mjs",
      content: "x",
    })
    expectDecision(d, "ask")
  })

  // VAL-M2-004
  test("VAL-M2-004: Edit dist/index.js → deny + redirect", async () => {
    const d = await run("Edit", {
      file_path: "/repo/dist/index.js",
      old_string: "a",
      new_string: "b",
    })
    expectDecision(d, "deny")
    const reason = (d as { hookSpecificOutput: { permissionDecisionReason: string } })
      .hookSpecificOutput.permissionDecisionReason
    expect(reason).toContain("src")
  })
  test("VAL-M2-004: Write *.generated.ts → deny + redirect", async () => {
    const d = await run("Write", {
      file_path: "/repo/src/api.generated.ts",
      content: "x",
    })
    expectDecision(d, "deny")
    const reason = (d as { hookSpecificOutput: { permissionDecisionReason: string } })
      .hookSpecificOutput.permissionDecisionReason
    expect(reason.toLowerCase()).toMatch(/template|generator|schema/)
  })

  // VAL-M2-005
  test("VAL-M2-005: Edit package-lock.json → ask", async () => {
    const d = await run("Edit", {
      file_path: "/repo/package-lock.json",
      old_string: "a",
      new_string: "b",
    })
    expectDecision(d, "ask")
  })
  test("VAL-M2-005: Edit pnpm-lock.yaml → ask", async () => {
    const d = await run("Edit", {
      file_path: "/repo/pnpm-lock.yaml",
      old_string: "a",
      new_string: "b",
    })
    expectDecision(d, "ask")
  })
  test("VAL-M2-005: Write Cargo.lock → ask", async () => {
    const d = await run("Write", {
      file_path: "/repo/Cargo.lock",
      content: "x",
    })
    expectDecision(d, "ask")
  })

  // Negative / no-over-block
  test("allow path: Bash git status → no decision (passthrough)", async () => {
    const d = await run("Bash", { command: "git status" })
    expect(d).toEqual({})
  })
  test("allow path: Read src/foo.ts → no decision (passthrough)", async () => {
    const d = await run("Read", { file_path: "/repo/src/foo.ts" })
    expect(d).toEqual({})
  })
  test("allow path: Write src/new.ts → no decision (passthrough)", async () => {
    const d = await run("Write", { file_path: "/repo/src/new.ts", content: "x" })
    expect(d).toEqual({})
  })
})
