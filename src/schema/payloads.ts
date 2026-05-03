import { Schema } from "effect"

const Common = {
  session_id: Schema.String,
  transcript_path: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
}

export const SessionStart = Schema.TaggedStruct("SessionStart", {
  ...Common,
  hook_event_name: Schema.Literal("SessionStart"),
  source: Schema.optional(Schema.String),
})

export const UserPromptSubmit = Schema.TaggedStruct("UserPromptSubmit", {
  ...Common,
  hook_event_name: Schema.Literal("UserPromptSubmit"),
  prompt: Schema.String,
})

export const UserPromptExpansion = Schema.TaggedStruct("UserPromptExpansion", {
  ...Common,
  hook_event_name: Schema.Literal("UserPromptExpansion"),
  prompt: Schema.String,
  expanded_prompt: Schema.optional(Schema.String),
})

export const PreToolUse = Schema.TaggedStruct("PreToolUse", {
  ...Common,
  hook_event_name: Schema.Literal("PreToolUse"),
  tool_name: Schema.String,
  tool_input: Schema.Unknown,
})

export const PostToolUse = Schema.TaggedStruct("PostToolUse", {
  ...Common,
  hook_event_name: Schema.Literal("PostToolUse"),
  tool_name: Schema.String,
  tool_input: Schema.Unknown,
  tool_response: Schema.Unknown,
})

export const PostToolUseFailure = Schema.TaggedStruct("PostToolUseFailure", {
  ...Common,
  hook_event_name: Schema.Literal("PostToolUseFailure"),
  tool_name: Schema.String,
  tool_input: Schema.Unknown,
  error: Schema.Unknown,
})

export const PostToolBatch = Schema.TaggedStruct("PostToolBatch", {
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

export const Stop = Schema.TaggedStruct("Stop", {
  ...Common,
  hook_event_name: Schema.Literal("Stop"),
  stop_hook_active: Schema.optional(Schema.Boolean),
})

export const PreCompact = Schema.TaggedStruct("PreCompact", {
  ...Common,
  hook_event_name: Schema.Literal("PreCompact"),
  trigger: Schema.optional(Schema.String),
  custom_instructions: Schema.optional(Schema.String),
})

export const PostCompact = Schema.TaggedStruct("PostCompact", {
  ...Common,
  hook_event_name: Schema.Literal("PostCompact"),
  trigger: Schema.optional(Schema.String),
})

export const SessionEnd = Schema.TaggedStruct("SessionEnd", {
  ...Common,
  hook_event_name: Schema.Literal("SessionEnd"),
  reason: Schema.optional(Schema.String),
})

export const PermissionRequest = Schema.TaggedStruct("PermissionRequest", {
  ...Common,
  hook_event_name: Schema.Literal("PermissionRequest"),
  tool_name: Schema.String,
  tool_input: Schema.Unknown,
})

export const ConfigChange = Schema.TaggedStruct("ConfigChange", {
  ...Common,
  hook_event_name: Schema.Literal("ConfigChange"),
  scope: Schema.optional(Schema.String),
  changes: Schema.optional(Schema.Unknown),
})

export const FileChanged = Schema.TaggedStruct("FileChanged", {
  ...Common,
  hook_event_name: Schema.Literal("FileChanged"),
  file_path: Schema.String,
  change_type: Schema.optional(Schema.String),
})

export const SubagentStart = Schema.TaggedStruct("SubagentStart", {
  ...Common,
  hook_event_name: Schema.Literal("SubagentStart"),
  subagent_type: Schema.optional(Schema.String),
  task_id: Schema.optional(Schema.String),
})

export const SubagentStop = Schema.TaggedStruct("SubagentStop", {
  ...Common,
  hook_event_name: Schema.Literal("SubagentStop"),
  subagent_type: Schema.optional(Schema.String),
  task_id: Schema.optional(Schema.String),
})

export const TaskCreated = Schema.TaggedStruct("TaskCreated", {
  ...Common,
  hook_event_name: Schema.Literal("TaskCreated"),
  task_id: Schema.String,
  description: Schema.optional(Schema.String),
})

export const TaskCompleted = Schema.TaggedStruct("TaskCompleted", {
  ...Common,
  hook_event_name: Schema.Literal("TaskCompleted"),
  task_id: Schema.String,
  status: Schema.optional(Schema.String),
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
} as const

export const HOOK_EVENT_NAMES: ReadonlyArray<keyof typeof PAYLOAD_SCHEMAS> = [
  "SessionStart",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Stop",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
  "PermissionRequest",
  "ConfigChange",
  "FileChanged",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
]
