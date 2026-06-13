import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { handlePostToolBatch } from "../../src/events/batch-context-governor.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import {
  EMPTY_SESSION_STATE,
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

  test("missing tool response does not mark verification as passed", async () => {
    const layer = SessionStateTest()
    const payload = batch("sid-missing-response", [
      { tool_name: "Bash", tool_input: { command: "bun test" } },
    ])
    const program = Effect.gen(function* () {
      yield* handlePostToolBatch(payload)
      const s = yield* SessionState
      return yield* s.get("sid-missing-response")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.verification_status).toBe("failed")
    expect(r.commands_failed).toContain("bun test")
  })

  test("failed verification in same batch sets failure-oriented next action", async () => {
    const layer = SessionStateTest()
    const payload = batch("sid-4b", [
      { tool_name: "Edit", tool_input: { file_path: "/repo/src/x.ts" }, tool_response: { success: true } },
      { tool_name: "Bash", tool_input: { command: "bun test" }, tool_response: { exitCode: 1 } },
    ])
    const program = Effect.gen(function* () {
      yield* handlePostToolBatch(payload)
      const s = yield* SessionState
      return yield* s.get("sid-4b")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.verification_status).toBe("failed")
    expect(r.next_required_action ?? "").toContain("failure output")
  })

  test("does not treat incidental words like latest as verification", async () => {
    const layer = SessionStateTest()
    const payload = batch("sid-4c", [
      { tool_name: "Bash", tool_input: { command: "rg latest src" }, tool_response: { success: true } },
    ])
    const program = Effect.gen(function* () {
      yield* handlePostToolBatch(payload)
      const s = yield* SessionState
      return yield* s.get("sid-4c")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.commands_run).toContain("rg latest src")
    expect(r.tests_run).not.toContain("rg latest src")
    expect(r.verification_status).toBe("none")
  })

  test("does not treat echoed verification words as a verification command", async () => {
    const layer = SessionStateTest()
    const payload = batch("sid-4f", [
      { tool_name: "Bash", tool_input: { command: "echo bun test" }, tool_response: { success: true } },
    ])
    const program = Effect.gen(function* () {
      yield* handlePostToolBatch(payload)
      const s = yield* SessionState
      return yield* s.get("sid-4f")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.commands_run).toContain("echo bun test")
    expect(r.tests_run).not.toContain("echo bun test")
    expect(r.verification_status).toBe("none")
  })

  test("does not record failed edit tools as changed files", async () => {
    const layer = SessionStateTest()
    const payload = batch("sid-4d", [
      {
        tool_name: "Write",
        tool_input: { file_path: "/repo/src/x.ts" },
        tool_response: { success: false, error: "permission denied" },
      },
    ])
    const program = Effect.gen(function* () {
      yield* handlePostToolBatch(payload)
      const s = yield* SessionState
      return yield* s.get("sid-4d")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.files_changed).not.toContain("/repo/src/x.ts")
    expect(r.next_required_action).toBeNull()
  })

  // Hook meta-artifact loop fix: edits to ISA.md / verify-map.yaml are
  // documentation of verification, not subjects of it. See
  // post-edit-quality.ts for the self-trap rationale.
  test("does not record ISA.md edits in files_changed (meta-artifact)", async () => {
    const layer = SessionStateTest()
    const isaPath = "/repo/.claude-hooks/work/abc123/ISA.md"
    const payload = batch("sid-meta-isa", [
      {
        tool_name: "Write",
        tool_input: { file_path: isaPath },
        tool_response: { success: true },
      },
      {
        tool_name: "Edit",
        tool_input: { file_path: "/repo/src/real.ts" },
        tool_response: { success: true },
      },
    ])
    const program = Effect.gen(function* () {
      yield* handlePostToolBatch(payload)
      const s = yield* SessionState
      return yield* s.get("sid-meta-isa")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.files_changed).not.toContain(isaPath)
    expect(r.files_changed).toContain("/repo/src/real.ts")
    expect(r.meta_artifacts_changed).toContain(isaPath)
  })

  test("does not record verify-map.yaml edits in files_changed (meta-artifact)", async () => {
    const layer = SessionStateTest()
    const vmPath = "/repo/.claude-hooks/verify-map.yaml"
    const payload = batch("sid-meta-vm", [
      {
        tool_name: "Edit",
        tool_input: { file_path: vmPath },
        tool_response: { success: true },
      },
    ])
    const program = Effect.gen(function* () {
      yield* handlePostToolBatch(payload)
      const s = yield* SessionState
      return yield* s.get("sid-meta-vm")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.files_changed).not.toContain(vmPath)
    expect(r.meta_artifacts_changed).toContain(vmPath)
    expect(r.next_required_action ?? "").toContain("meta-artifact")
  })

  test("does not record session .claude-hooks/work edits in files_changed", async () => {
    const layer = SessionStateTest(
      new Map([
        ["sid-meta-work", { ...EMPTY_SESSION_STATE, session_root: "/repo" }],
      ]),
    )
    const workArtifact = "/repo/.claude-hooks/work/abc123/verify-map.yaml"
    const payload = batch("sid-meta-work", [
      {
        tool_name: "Write",
        tool_input: { file_path: workArtifact },
        tool_response: { success: true },
      },
    ])
    const program = Effect.gen(function* () {
      yield* handlePostToolBatch(payload)
      const s = yield* SessionState
      return yield* s.get("sid-meta-work")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.files_changed).not.toContain(workArtifact)
    expect(r.meta_artifacts_changed).toContain(workArtifact)
    expect(r.next_required_action ?? "").toContain("meta-artifact")
  })

  test("records foreign verify-map.yaml as files_changed when cwd scopes the active config", async () => {
    const layer = SessionStateTest()
    const foreignPath = "/repo/fixtures/.claude-hooks/verify-map.yaml"
    const payload = decode({
      _tag: "PostToolBatch",
      session_id: "sid-foreign-vm",
      hook_event_name: "PostToolBatch",
      cwd: "/repo",
      tools: [
        {
          tool_name: "Edit",
          tool_input: { file_path: foreignPath },
          tool_response: { success: true },
        },
      ],
    })
    const program = Effect.gen(function* () {
      yield* handlePostToolBatch(payload)
      const s = yield* SessionState
      return yield* s.get("sid-foreign-vm")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.files_changed).toContain(foreignPath)
    expect(r.meta_artifacts_changed).not.toContain(foreignPath)
  })

  test("records source URLs from source tool UI aliases", async () => {
    const layer = SessionStateTest()
    const payload = batch("sid-4e", [
      {
        tool_name: "Web Search",
        tool_input: { query: "roofing benchmark" },
        tool_response: "Result: https://example.com/roofing",
      },
    ])
    const program = Effect.gen(function* () {
      yield* handlePostToolBatch(payload)
      const s = yield* SessionState
      return yield* s.get("sid-4e")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.source_urls).toEqual(["https://example.com/roofing"])
  })

  test("does not treat URLs in search queries as fetched source evidence", async () => {
    const layer = SessionStateTest()
    const payload = batch("sid-query-url-only", [
      {
        tool_name: "Web Search",
        tool_input: { query: "Read https://example.com/roofing" },
        tool_response: "Did 1 search in 6s",
      },
    ])
    const program = Effect.gen(function* () {
      yield* handlePostToolBatch(payload)
      const s = yield* SessionState
      return yield* s.get("sid-query-url-only")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.source_urls).toEqual([])
  })

  test("does not record dead fetch URLs as usable source evidence", async () => {
    const layer = SessionStateTest()
    const payload = batch("sid-4g", [
      {
        tool_name: "WebFetch",
        tool_input: { url: "https://example.com/dead", prompt: "extract" },
        tool_response: "Received 0 bytes (403 Forbidden)",
      },
    ])
    const program = Effect.gen(function* () {
      yield* handlePostToolBatch(payload)
      const s = yield* SessionState
      return yield* s.get("sid-4g")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.source_urls).toEqual([])
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
