import { Schema } from "effect"
import {
  HOOK_EVENT_NAMES as CANONICAL_HOOK_EVENT_NAMES,
  type HookEventName,
} from "./hook-events.ts"

const Common = {
  session_id: Schema.String,
  transcript_path: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
}

/**
 * Per the official Claude Code hook spec, tool-related events carry a
 * `permission_mode` (one of the documented modes — modeled as a string here
 * to stay forward-compatible with future modes) and a `tool_use_id`.
 */
const ToolCommon = {
  permission_mode: Schema.optional(Schema.String),
  tool_use_id: Schema.optional(Schema.String),
  agent_id: Schema.optional(Schema.String),
  task_id: Schema.optional(Schema.String),
  worker_id: Schema.optional(Schema.String),
}

/**
 * Build a hook-payload variant that:
 *   - Decodes from the wire format Claude Code actually sends (no `_tag`,
 *     uses `hook_event_name` as the discriminator).
 *   - Carries an Effect-style `_tag` on the decoded type so existing handler
 *     code (`payload._tag === "PreToolUse"`, etc.) keeps working unchanged.
 *
 * Use this instead of `Schema.TaggedStruct` for any schema modeling an
 * external protocol where the producer does NOT serialize `_tag`.
 */
const variant = <Tag extends string, Fields extends Schema.Struct.Fields>(
  tag: Tag,
  fields: Fields,
) => Schema.Struct(fields).pipe(Schema.attachPropertySignature("_tag", tag))

export const SessionStart = variant("SessionStart", {
  ...Common,
  hook_event_name: Schema.Literal("SessionStart"),
  source: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  agent_type: Schema.optional(Schema.String),
})

export const UserPromptSubmit = variant("UserPromptSubmit", {
  ...Common,
  hook_event_name: Schema.Literal("UserPromptSubmit"),
  prompt: Schema.String,
})

export const UserPromptExpansion = variant("UserPromptExpansion", {
  ...Common,
  hook_event_name: Schema.Literal("UserPromptExpansion"),
  prompt: Schema.String,
  expanded_prompt: Schema.optional(Schema.String),
})

export const PreToolUse = variant("PreToolUse", {
  ...Common,
  ...ToolCommon,
  hook_event_name: Schema.Literal("PreToolUse"),
  tool_name: Schema.String,
  tool_input: Schema.Unknown,
})

export const PostToolUse = variant("PostToolUse", {
  ...Common,
  ...ToolCommon,
  hook_event_name: Schema.Literal("PostToolUse"),
  tool_name: Schema.String,
  tool_input: Schema.Unknown,
  tool_response: Schema.Unknown,
})

export const PostToolUseFailure = variant("PostToolUseFailure", {
  ...Common,
  ...ToolCommon,
  hook_event_name: Schema.Literal("PostToolUseFailure"),
  tool_name: Schema.String,
  tool_input: Schema.Unknown,
  error: Schema.Unknown,
  error_type: Schema.optional(Schema.String),
})

export const PostToolBatch = variant("PostToolBatch", {
  ...Common,
  hook_event_name: Schema.Literal("PostToolBatch"),
  tools: Schema.Array(
    Schema.Struct({
      tool_name: Schema.String,
      tool_input: Schema.Unknown,
      tool_response: Schema.optional(Schema.Unknown),
    }),
  ),
})

/**
 * Stop event. Per the official Claude Code spec, the payload carries an
 * `assistant_message` (the model's most-recent message) — there is NO
 * `stop_hook_active` field; loop-protection must be tracked locally
 * via `SessionState.stop_blocked_once`.
 */
export const Stop = variant("Stop", {
  ...Common,
  hook_event_name: Schema.Literal("Stop"),
  assistant_message: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Unknown),
})

export const PreCompact = variant("PreCompact", {
  ...Common,
  hook_event_name: Schema.Literal("PreCompact"),
  trigger: Schema.optional(Schema.String),
  custom_instructions: Schema.optional(Schema.String),
})

export const PostCompact = variant("PostCompact", {
  ...Common,
  hook_event_name: Schema.Literal("PostCompact"),
  trigger: Schema.optional(Schema.String),
})

export const SessionEnd = variant("SessionEnd", {
  ...Common,
  hook_event_name: Schema.Literal("SessionEnd"),
  reason: Schema.optional(Schema.String),
})

export const PermissionRequest = variant("PermissionRequest", {
  ...Common,
  ...ToolCommon,
  hook_event_name: Schema.Literal("PermissionRequest"),
  tool_name: Schema.String,
  tool_input: Schema.Unknown,
  permission_suggestions: Schema.optional(Schema.Array(Schema.Unknown)),
})

export const ConfigChange = variant("ConfigChange", {
  ...Common,
  hook_event_name: Schema.Literal("ConfigChange"),
  scope: Schema.optional(Schema.String),
  changes: Schema.optional(Schema.Unknown),
})

export const FileChanged = variant("FileChanged", {
  ...Common,
  hook_event_name: Schema.Literal("FileChanged"),
  file_path: Schema.String,
  change_type: Schema.optional(Schema.String),
})

/**
 * SubagentStart / SubagentStop. Per the official spec the payload uses
 * `agent_type` (not `subagent_type`), an `agent_id` correlation token, and
 * `prompt` (start) / `output` (stop). We accept legacy `subagent_type` /
 * `result` / `task_id` as optional fields for backward-compat with older
 * Claude Code builds and existing tests, but the canonical fields are
 * `agent_type`, `agent_id`, `prompt`, `output`.
 */
export const SubagentStart = variant("SubagentStart", {
  ...Common,
  hook_event_name: Schema.Literal("SubagentStart"),
  agent_type: Schema.optional(Schema.String),
  agent_id: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  // legacy compatibility
  subagent_type: Schema.optional(Schema.String),
  task_id: Schema.optional(Schema.String),
})

export const SubagentStop = variant("SubagentStop", {
  ...Common,
  hook_event_name: Schema.Literal("SubagentStop"),
  agent_type: Schema.optional(Schema.String),
  agent_id: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
  // legacy compatibility
  subagent_type: Schema.optional(Schema.String),
  task_id: Schema.optional(Schema.String),
  result: Schema.optional(Schema.String),
})

export const TaskCreated = variant("TaskCreated", {
  ...Common,
  hook_event_name: Schema.Literal("TaskCreated"),
  task_id: Schema.String,
  description: Schema.optional(Schema.String),
})

export const TaskCompleted = variant("TaskCompleted", {
  ...Common,
  hook_event_name: Schema.Literal("TaskCompleted"),
  task_id: Schema.String,
  status: Schema.optional(Schema.String),
  acceptance_criteria: Schema.optional(Schema.String),
  evidence: Schema.optional(Schema.Array(Schema.String)),
  metadata: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
})

/**
 * Setup — first-time project setup. Per spec, no `permission_mode`.
 */
export const Setup = variant("Setup", {
  ...Common,
  hook_event_name: Schema.Literal("Setup"),
  trigger: Schema.optional(Schema.Literal("init", "maintenance")),
})

/**
 * PermissionDenied — fired after Claude Code rejects a permission request.
 * Carries `permission_mode` per spec (tool-related event).
 */
export const PermissionDenied = variant("PermissionDenied", {
  ...Common,
  permission_mode: Schema.optional(Schema.String),
  hook_event_name: Schema.Literal("PermissionDenied"),
  tool_name: Schema.String,
  tool_input: Schema.Unknown,
  denial_reason: Schema.String,
})

/**
 * StopFailure — failure inside a Stop hook. Per spec, no `permission_mode`.
 */
export const StopFailure = variant("StopFailure", {
  ...Common,
  hook_event_name: Schema.Literal("StopFailure"),
  error_type: Schema.String,
  error_message: Schema.String,
})

export const TeammateIdle = variant("TeammateIdle", {
  ...Common,
  hook_event_name: Schema.Literal("TeammateIdle"),
  teammate_name: Schema.String,
  teammate_type: Schema.String,
})

export const Notification = variant("Notification", {
  ...Common,
  hook_event_name: Schema.Literal("Notification"),
  notification_type: Schema.String,
  message: Schema.String,
})

export const InstructionsLoaded = variant("InstructionsLoaded", {
  ...Common,
  hook_event_name: Schema.Literal("InstructionsLoaded"),
  file_path: Schema.String,
  memory_type: Schema.Literal("User", "Project", "Local", "Managed"),
  load_reason: Schema.String,
  globs: Schema.optional(Schema.Array(Schema.String)),
  trigger_file_path: Schema.optional(Schema.String),
  parent_file_path: Schema.optional(Schema.String),
})

export const CwdChanged = variant("CwdChanged", {
  ...Common,
  hook_event_name: Schema.Literal("CwdChanged"),
  previous_cwd: Schema.String,
  new_cwd: Schema.String,
})

export const WorktreeCreate = variant("WorktreeCreate", {
  ...Common,
  hook_event_name: Schema.Literal("WorktreeCreate"),
  base_path: Schema.String,
  worktree_name: Schema.String,
})

export const WorktreeRemove = variant("WorktreeRemove", {
  ...Common,
  hook_event_name: Schema.Literal("WorktreeRemove"),
  worktree_path: Schema.String,
})

export const Elicitation = variant("Elicitation", {
  ...Common,
  hook_event_name: Schema.Literal("Elicitation"),
  server_name: Schema.String,
  tool_name: Schema.String,
  elicitation: Schema.Unknown,
})

export const ElicitationResult = variant("ElicitationResult", {
  ...Common,
  hook_event_name: Schema.Literal("ElicitationResult"),
  server_name: Schema.String,
  tool_name: Schema.String,
  action: Schema.Literal("accept", "decline", "cancel"),
  content: Schema.optional(Schema.Unknown),
})

export const HookPayload = Schema.Union(
  SessionStart,
  UserPromptSubmit,
  UserPromptExpansion,
  PreToolUse,
  PostToolUse,
  PostToolUseFailure,
  PostToolBatch,
  Stop,
  PreCompact,
  PostCompact,
  SessionEnd,
  PermissionRequest,
  ConfigChange,
  FileChanged,
  SubagentStart,
  SubagentStop,
  TaskCreated,
  TaskCompleted,
  Setup,
  PermissionDenied,
  StopFailure,
  TeammateIdle,
  Notification,
  InstructionsLoaded,
  CwdChanged,
  WorktreeCreate,
  WorktreeRemove,
  Elicitation,
  ElicitationResult,
)

export type HookPayload = Schema.Schema.Type<typeof HookPayload>

export const PAYLOAD_SCHEMAS = {
  SessionStart,
  UserPromptSubmit,
  UserPromptExpansion,
  PreToolUse,
  PostToolUse,
  PostToolUseFailure,
  PostToolBatch,
  Stop,
  PreCompact,
  PostCompact,
  SessionEnd,
  PermissionRequest,
  ConfigChange,
  FileChanged,
  SubagentStart,
  SubagentStop,
  TaskCreated,
  TaskCompleted,
  Setup,
  PermissionDenied,
  StopFailure,
  TeammateIdle,
  Notification,
  InstructionsLoaded,
  CwdChanged,
  WorktreeCreate,
  WorktreeRemove,
  Elicitation,
  ElicitationResult,
} as const

const _payloadSchemasCoverHooks: Record<HookEventName, unknown> =
  PAYLOAD_SCHEMAS
void _payloadSchemasCoverHooks

export const HOOK_EVENT_NAMES = CANONICAL_HOOK_EVENT_NAMES
