import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { handlePostToolBatch } from "../../src/events/batch-context-governor.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import {
  SessionState,
  SessionStateTest,
} from "../../src/services/session-state.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const batch = (sid: string, tools: ReadonlyArray<unknown>) =>
  decode({
    _tag: "PostToolBatch",
    session_id: sid,
    hook_event_name: "PostToolBatch",
    tools,
  })

describe("handlePostToolBatch", () => {
  test("additionalContext under 500 chars", async () => {
    const layer = SessionStateTest()
    const payload = batch("sid-1", [
      { tool_name: "Read", tool_input: { file_path: "/a.ts" } },
      { tool_name: "Edit", tool_input: { file_path: "/a.ts" } },
      { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { success: true } },
    ])
    const d = await Effect.runPromise(
      handlePostToolBatch(payload).pipe(Effect.provide(layer)),
    )
    const out = d as { hookSpecificOutput: { additionalContext: string } }
    expect(out.hookSpecificOutput.additionalContext.length).toBeLessThan(500)
  })

  test("ledger updated with files_changed and commands_run", async () => {
    const layer = SessionStateTest()
    const payload = batch("sid-2", [
      { tool_name: "Edit", tool_input: { file_path: "/repo/src/x.ts" } },
      { tool_name: "Bash", tool_input: { command: "echo hi" }, tool_response: { success: true } },
    ])
    const program = Effect.gen(function* () {
      yield* handlePostToolBatch(payload)
      const s = yield* SessionState
      return yield* s.get("sid-2")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.files_changed).toContain("/repo/src/x.ts")
    expect(r.commands_run).toContain("echo hi")
  })

  test("verification_status=passed when bun test succeeds", async () => {
    const layer = SessionStateTest()
    const payload = batch("sid-3", [
      { tool_name: "Bash", tool_input: { command: "bun test" }, tool_response: { success: true } },
    ])
    const program = Effect.gen(function* () {
      yield* handlePostToolBatch(payload)
      const s = yield* SessionState
      return yield* s.get("sid-3")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.verification_status).toBe("passed")
    expect(r.tests_run).toContain("bun test")
  })

  test("verification_status=failed when test command fails", async () => {
    const layer = SessionStateTest()
    const payload = batch("sid-4", [
      { tool_name: "Bash", tool_input: { command: "bun test" }, tool_response: { exitCode: 1 } },
    ])
    const program = Effect.gen(function* () {
      yield* handlePostToolBatch(payload)
      const s = yield* SessionState
      return yield* s.get("sid-4")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.verification_status).toBe("failed")
    expect(r.commands_failed).toContain("bun test")
  })

  test("next_required_action set when files changed without verify", async () => {
    const layer = SessionStateTest()
    const payload = batch("sid-5", [
      { tool_name: "Edit", tool_input: { file_path: "/repo/y.ts" } },
    ])
    const program = Effect.gen(function* () {
      yield* handlePostToolBatch(payload)
      const s = yield* SessionState
      return yield* s.get("sid-5")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.next_required_action).not.toBeNull()
    expect(r.next_required_action ?? "").toMatch(/test|typecheck/)
  })
})
