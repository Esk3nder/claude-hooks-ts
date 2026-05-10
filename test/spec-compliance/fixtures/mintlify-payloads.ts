// Raw wire payloads matching the Mintlify-documented hook contract.
// Source: https://mintlify.wiki/VineeTagarwaL-code/claude-code/reference/sdk/hooks-reference.md
//
// IMPORTANT: these are RAW shapes (no `_tag` field). Tests run each
// payload through Schema.decodeUnknownSync(HookPayload) which adds the
// discriminator from `hook_event_name`.
//
// DOC_DRIFT findings are annotated inline. Where the package's schema
// uses a different field name than Mintlify documents, fixtures match
// the schema (so handler-smoke can run); the divergence is what the
// audit surfaces.

export const SPEC_ROOT = "/tmp/claude-hooks-ts-spec"

const sessionEnvelope = (cwd: string = SPEC_ROOT) => ({
  session_id: "spec-session",
  transcript_path: `${cwd}/transcript.jsonl`,
  cwd,
})

export const preToolUse = (cwd?: string) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Read",
  tool_input: { file_path: "/tmp/x" },
  tool_use_id: "tu-1",
  ...sessionEnvelope(cwd),
})

export const postToolUse = (cwd?: string) => ({
  hook_event_name: "PostToolUse",
  tool_name: "Read",
  tool_input: { file_path: "/tmp/x" },
  tool_response: { ok: true },
  tool_use_id: "tu-1",
  ...sessionEnvelope(cwd),
})

export const postToolUseFailure = (cwd?: string) => ({
  hook_event_name: "PostToolUseFailure",
  tool_name: "Read",
  tool_input: { file_path: "/tmp/x" },
  tool_use_id: "tu-1",
  error: "boom",
  is_interrupt: false,
  ...sessionEnvelope(cwd),
})

export const permissionRequest = (cwd?: string) => ({
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "ls" },
  permission_suggestions: [],
  ...sessionEnvelope(cwd),
})

// DOC_DRIFT: Mintlify documents `reason` + `tool_use_id`; schema uses
// `denial_reason` and has no `tool_use_id`.
export const permissionDenied = (cwd?: string) => ({
  hook_event_name: "PermissionDenied",
  tool_name: "Bash",
  tool_input: { command: "ls" },
  denial_reason: "user denied",
  ...sessionEnvelope(cwd),
})

export const stop = (cwd?: string) => ({
  hook_event_name: "Stop",
  stop_hook_active: false,
  last_assistant_message: "done",
  ...sessionEnvelope(cwd),
})

// DOC_DRIFT: Mintlify documents `error` + `error_details` +
// `last_assistant_message`; schema uses `error_type` + `error_message`
// (no last_assistant_message).
export const stopFailure = (cwd?: string) => ({
  hook_event_name: "StopFailure",
  error_type: "user_interrupt",
  error_message: "ctrl-c",
  ...sessionEnvelope(cwd),
})

export const subagentStart = (cwd?: string) => ({
  hook_event_name: "SubagentStart",
  agent_id: "a-1",
  agent_type: "general-purpose",
  ...sessionEnvelope(cwd),
})

export const subagentStop = (cwd?: string) => ({
  hook_event_name: "SubagentStop",
  agent_id: "a-1",
  agent_type: "general-purpose",
  agent_transcript_path: `${cwd ?? SPEC_ROOT}/agent.jsonl`,
  stop_hook_active: false,
  last_assistant_message: "subagent done",
  ...sessionEnvelope(cwd),
})

export const sessionStart = (cwd?: string) => ({
  hook_event_name: "SessionStart",
  source: "startup",
  model: "claude-opus-4-7",
  ...sessionEnvelope(cwd),
})

export const sessionEnd = (cwd?: string) => ({
  hook_event_name: "SessionEnd",
  reason: "user_exit",
  ...sessionEnvelope(cwd),
})

export const setup = (cwd?: string) => ({
  hook_event_name: "Setup",
  trigger: "init",
  ...sessionEnvelope(cwd),
})

// DOC_DRIFT (minor): Mintlify allows custom_instructions: string|null;
// schema is Schema.optional(Schema.String) which rejects null.
// Fixture omits the optional field instead of passing null.
export const preCompact = (cwd?: string) => ({
  hook_event_name: "PreCompact",
  trigger: "manual",
  ...sessionEnvelope(cwd),
})

export const postCompact = (cwd?: string) => ({
  hook_event_name: "PostCompact",
  trigger: "manual",
  compact_summary: "summary",
  ...sessionEnvelope(cwd),
})

export const userPromptSubmit = (cwd?: string) => ({
  hook_event_name: "UserPromptSubmit",
  prompt: "hello",
  ...sessionEnvelope(cwd),
})

export const notification = (cwd?: string) => ({
  hook_event_name: "Notification",
  message: "msg",
  title: "title",
  notification_type: "info",
  ...sessionEnvelope(cwd),
})

// DOC_DRIFT: Mintlify documents mcp_server_name, message, mode,
// elicitation_id, requested_schema; schema uses server_name, tool_name,
// elicitation. Completely different field shape.
export const elicitation = (cwd?: string) => ({
  hook_event_name: "Elicitation",
  server_name: "mcp",
  tool_name: "confirm",
  elicitation: { message: "please confirm" },
  ...sessionEnvelope(cwd),
})

// DOC_DRIFT: Mintlify documents mcp_server_name, elicitation_id, action,
// content; schema uses server_name, tool_name, action, content.
export const elicitationResult = (cwd?: string) => ({
  hook_event_name: "ElicitationResult",
  server_name: "mcp",
  tool_name: "confirm",
  action: "accept",
  content: {},
  ...sessionEnvelope(cwd),
})

export const configChange = (cwd?: string) => ({
  hook_event_name: "ConfigChange",
  source: "settings.json",
  file_path: `${cwd ?? SPEC_ROOT}/settings.json`,
  ...sessionEnvelope(cwd),
})

export const instructionsLoaded = (cwd?: string) => ({
  hook_event_name: "InstructionsLoaded",
  file_path: `${cwd ?? SPEC_ROOT}/CLAUDE.md`,
  memory_type: "Project",
  load_reason: "auto",
  globs: [],
  trigger_file_path: `${cwd ?? SPEC_ROOT}/x.ts`,
  parent_file_path: `${cwd ?? SPEC_ROOT}/CLAUDE.md`,
  ...sessionEnvelope(cwd),
})

// DOC_DRIFT: Mintlify documents `name`; schema uses `base_path` +
// `worktree_name`.
export const worktreeCreate = (cwd?: string) => ({
  hook_event_name: "WorktreeCreate",
  base_path: cwd ?? SPEC_ROOT,
  worktree_name: "wt-1",
  ...sessionEnvelope(cwd),
})

export const worktreeRemove = (cwd?: string) => ({
  hook_event_name: "WorktreeRemove",
  worktree_path: "/tmp/wt-1",
  ...sessionEnvelope(cwd),
})

// DOC_DRIFT: Mintlify documents `old_cwd`; schema uses `previous_cwd`.
export const cwdChanged = (cwd?: string) => ({
  hook_event_name: "CwdChanged",
  previous_cwd: "/old",
  new_cwd: cwd ?? SPEC_ROOT,
  ...sessionEnvelope(cwd),
})

export const fileChanged = (cwd?: string) => ({
  hook_event_name: "FileChanged",
  file_path: `${cwd ?? SPEC_ROOT}/foo.ts`,
  event: "change",
  ...sessionEnvelope(cwd),
})

// Guide-only documented (guides/hooks.md, NOT in reference).
export const taskCreated = (cwd?: string) => ({
  hook_event_name: "TaskCreated",
  task_id: "T-1",
  task_subject: "subject",
  task_description: "description",
  teammate_name: "claude",
  team_name: "team",
  ...sessionEnvelope(cwd),
})

// Strict Mintlify-documented payload (no AC/evidence anywhere).
export const taskCompletedDocumentedOnly = (cwd?: string) => ({
  hook_event_name: "TaskCompleted",
  task_id: "T-1",
  task_subject: "subject",
  task_description: "description",
  teammate_name: "claude",
  team_name: "team",
  ...sessionEnvelope(cwd),
})

// Policy-extension shape: Mintlify-documented payload PLUS the AC/evidence
// the package's task-integrity gate requires, here under metadata (the
// only writable freeform parameter on Claude Code's TaskUpdate tool).
export const taskCompletedWithMetadata = (cwd?: string) => ({
  hook_event_name: "TaskCompleted",
  task_id: "T-1",
  task_subject: "subject",
  task_description: "description",
  teammate_name: "claude",
  team_name: "team",
  metadata: {
    acceptance_criteria: "Tests pass",
    evidence: ["bun test exit 0"],
  },
  ...sessionEnvelope(cwd),
})
