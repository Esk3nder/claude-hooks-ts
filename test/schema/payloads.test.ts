import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  PAYLOAD_SCHEMAS,
  HOOK_EVENT_NAMES,
  HookPayload,
} from "../../src/schema/payloads.ts"

const FIXTURES: Record<string, unknown> = {
  SessionStart: {
    _tag: "SessionStart",
    session_id: "s1",
    hook_event_name: "SessionStart",
    source: "startup",
  },
  UserPromptSubmit: {
    _tag: "UserPromptSubmit",
    session_id: "s1",
    hook_event_name: "UserPromptSubmit",
    prompt: "hello",
  },
  UserPromptExpansion: {
    _tag: "UserPromptExpansion",
    session_id: "s1",
    hook_event_name: "UserPromptExpansion",
    prompt: "p",
  },
  PreToolUse: {
    _tag: "PreToolUse",
    session_id: "s1",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  },
  PostToolUse: {
    _tag: "PostToolUse",
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    tool_response: { stdout: "" },
  },
  PostToolUseFailure: {
    _tag: "PostToolUseFailure",
    session_id: "s1",
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    error: { message: "boom" },
  },
  PostToolBatch: {
    _tag: "PostToolBatch",
    session_id: "s1",
    hook_event_name: "PostToolBatch",
    tools: [{ tool_name: "Bash", tool_input: { command: "ls" } }],
  },
  Stop: {
    _tag: "Stop",
    session_id: "s1",
    hook_event_name: "Stop",
  },
  PreCompact: {
    _tag: "PreCompact",
    session_id: "s1",
    hook_event_name: "PreCompact",
    trigger: "auto",
  },
  PostCompact: {
    _tag: "PostCompact",
    session_id: "s1",
    hook_event_name: "PostCompact",
  },
  SessionEnd: {
    _tag: "SessionEnd",
    session_id: "s1",
    hook_event_name: "SessionEnd",
    reason: "user_quit",
  },
  PermissionRequest: {
    _tag: "PermissionRequest",
    session_id: "s1",
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "rm -rf /" },
  },
  ConfigChange: {
    _tag: "ConfigChange",
    session_id: "s1",
    hook_event_name: "ConfigChange",
    scope: "user",
  },
  FileChanged: {
    _tag: "FileChanged",
    session_id: "s1",
    hook_event_name: "FileChanged",
    file_path: "/x/y.ts",
  },
  SubagentStart: {
    _tag: "SubagentStart",
    session_id: "s1",
    hook_event_name: "SubagentStart",
  },
  SubagentStop: {
    _tag: "SubagentStop",
    session_id: "s1",
    hook_event_name: "SubagentStop",
  },
  TaskCreated: {
    _tag: "TaskCreated",
    session_id: "s1",
    hook_event_name: "TaskCreated",
    task_id: "t1",
  },
  TaskCompleted: {
    _tag: "TaskCompleted",
    session_id: "s1",
    hook_event_name: "TaskCompleted",
    task_id: "t1",
    status: "ok",
  },
}

describe("HookPayload union", () => {
  test("contains a variant for every Claude Code event (18)", () => {
    expect(HOOK_EVENT_NAMES.length).toBe(18)
    for (const name of HOOK_EVENT_NAMES) {
      expect(PAYLOAD_SCHEMAS[name]).toBeDefined()
    }
  })

  for (const name of HOOK_EVENT_NAMES) {
    test(`round-trip: ${name}`, () => {
      const fixture = FIXTURES[name]
      expect(fixture).toBeDefined()
      const decoded = Schema.decodeUnknownSync(HookPayload)(fixture)
      const encoded = Schema.encodeSync(HookPayload)(decoded)
      const reDecoded = Schema.decodeUnknownSync(HookPayload)(encoded)
      expect(reDecoded).toEqual(decoded)
    })
  }
})
