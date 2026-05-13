import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  PAYLOAD_SCHEMAS,
  HOOK_EVENT_NAMES,
  HookPayload,
} from "../../src/schema/payloads.ts"

/**
 * Fixtures match the wire format Claude Code actually sends — no `_tag`,
 * `hook_event_name` is the discriminator. The decoded payload still carries
 * `_tag` (attached at decode time) so handler code can pattern-match on it.
 */
const FIXTURES: Record<string, unknown> = {
  SessionStart: {
    session_id: "s1",
    hook_event_name: "SessionStart",
    source: "startup",
  },
  UserPromptSubmit: {
    session_id: "s1",
    hook_event_name: "UserPromptSubmit",
    prompt: "hello",
  },
  UserPromptExpansion: {
    session_id: "s1",
    hook_event_name: "UserPromptExpansion",
    prompt: "p",
  },
  PreToolUse: {
    session_id: "s1",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  },
  PostToolUse: {
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    tool_response: { stdout: "" },
  },
  PostToolUseFailure: {
    session_id: "s1",
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    error: { message: "boom" },
  },
  PostToolBatch: {
    session_id: "s1",
    hook_event_name: "PostToolBatch",
    tools: [{ tool_name: "Bash", tool_input: { command: "ls" } }],
  },
  Stop: {
    session_id: "s1",
    hook_event_name: "Stop",
  },
  PreCompact: {
    session_id: "s1",
    hook_event_name: "PreCompact",
    trigger: "auto",
  },
  PostCompact: {
    session_id: "s1",
    hook_event_name: "PostCompact",
  },
  SessionEnd: {
    session_id: "s1",
    hook_event_name: "SessionEnd",
    reason: "user_quit",
  },
  PermissionRequest: {
    session_id: "s1",
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "rm -rf /" },
  },
  ConfigChange: {
    session_id: "s1",
    hook_event_name: "ConfigChange",
    scope: "user",
  },
  FileChanged: {
    session_id: "s1",
    hook_event_name: "FileChanged",
    file_path: "/x/y.ts",
  },
  SubagentStart: {
    session_id: "s1",
    hook_event_name: "SubagentStart",
  },
  SubagentStop: {
    session_id: "s1",
    hook_event_name: "SubagentStop",
  },
  TaskCreated: {
    session_id: "s1",
    hook_event_name: "TaskCreated",
    task_id: "t1",
  },
  TaskCompleted: {
    session_id: "s1",
    hook_event_name: "TaskCompleted",
    task_id: "t1",
    status: "ok",
  },
  Setup: {
    session_id: "s1",
    hook_event_name: "Setup",
    trigger: "init",
  },
  PermissionDenied: {
    session_id: "s1",
    hook_event_name: "PermissionDenied",
    tool_name: "Bash",
    tool_input: { command: "rm -rf /" },
    denial_reason: "destructive",
  },
  StopFailure: {
    session_id: "s1",
    hook_event_name: "StopFailure",
    error_type: "timeout",
    error_message: "hook timed out",
  },
  TeammateIdle: {
    session_id: "s1",
    hook_event_name: "TeammateIdle",
    teammate_name: "researcher",
    teammate_type: "subagent",
  },
  Notification: {
    session_id: "s1",
    hook_event_name: "Notification",
    notification_type: "info",
    message: "hello",
  },
  InstructionsLoaded: {
    session_id: "s1",
    hook_event_name: "InstructionsLoaded",
    file_path: "/repo/CLAUDE.md",
    memory_type: "Project",
    load_reason: "session-start",
  },
  CwdChanged: {
    session_id: "s1",
    hook_event_name: "CwdChanged",
    previous_cwd: "/a",
    new_cwd: "/b",
  },
  WorktreeCreate: {
    session_id: "s1",
    hook_event_name: "WorktreeCreate",
    base_path: "/repo/.wt",
    worktree_name: "feat-x",
  },
  WorktreeRemove: {
    session_id: "s1",
    hook_event_name: "WorktreeRemove",
    worktree_path: "/repo/.wt/feat-x",
  },
  Elicitation: {
    session_id: "s1",
    hook_event_name: "Elicitation",
    server_name: "mcp.foo",
    tool_name: "ask",
    elicitation: { prompt: "?" },
  },
  ElicitationResult: {
    session_id: "s1",
    hook_event_name: "ElicitationResult",
    server_name: "mcp.foo",
    tool_name: "ask",
    action: "accept",
  },
}

describe("HookPayload union", () => {
  test("contains a variant for every Claude Code event (29)", () => {
    expect(HOOK_EVENT_NAMES.length).toBe(29)
    for (const name of HOOK_EVENT_NAMES) {
      expect(PAYLOAD_SCHEMAS[name]).toBeDefined()
    }
  })

  for (const name of HOOK_EVENT_NAMES) {
    test(`decodes wire format (no _tag) and attaches _tag: ${name}`, () => {
      const fixture = FIXTURES[name]
      expect(fixture).toBeDefined()
      const decoded = Schema.decodeUnknownSync(HookPayload)(fixture)
      // Wire format never includes `_tag` — schema attaches it at decode time.
      expect((decoded as { _tag: string })._tag).toBe(name)
      // Discriminator on the wire is `hook_event_name`, preserved verbatim.
      expect((decoded as { hook_event_name: string }).hook_event_name).toBe(
        name,
      )
    })
  }

  /**
   * Regression: prior versions used `Schema.TaggedStruct` which required `_tag`
   * to already be present on input. Real Claude Code never sends `_tag`, so
   * every real event silently fell through to NO_DECISION (allow). This test
   * locks the wire-format contract in place.
   */
  test("rejects no payload at all", () => {
    expect(() =>
      Schema.decodeUnknownSync(HookPayload)({ session_id: "s1" }),
    ).toThrow()
  })

  test("decodes a real PreToolUse with no _tag (issue #18 regression)", () => {
    const real = {
      session_id: "abc-123",
      transcript_path: "/Users/x/.claude/sessions/abc.jsonl",
      cwd: "/Users/x/proj",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
      tool_use_id: "tu_001",
    }
    const decoded = Schema.decodeUnknownSync(HookPayload)(real)
    expect((decoded as { _tag: string })._tag).toBe("PreToolUse")
  })
})
