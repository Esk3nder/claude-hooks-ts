import { Schema } from "effect"

export const PreToolUseDecision = Schema.Struct({
  hookSpecificOutput: Schema.Struct({
    hookEventName: Schema.Literal("PreToolUse"),
    permissionDecision: Schema.Literal("allow", "deny", "ask"),
    permissionDecisionReason: Schema.String,
    updatedInput: Schema.optional(Schema.Unknown),
  }),
})

export const PermissionRequestDecision = Schema.Struct({
  hookSpecificOutput: Schema.Struct({
    hookEventName: Schema.Literal("PermissionRequest"),
    permissionDecision: Schema.Literal("allow", "deny", "ask"),
    permissionDecisionReason: Schema.String,
  }),
})

export const StopDecision = Schema.Struct({
  decision: Schema.Literal("block"),
  reason: Schema.String,
})

export const ContextInjection = Schema.Struct({
  hookSpecificOutput: Schema.Struct({
    hookEventName: Schema.String,
    additionalContext: Schema.String,
  }),
})

export const NoOp = Schema.Struct({})

export const HookDecision = Schema.Union(
  PreToolUseDecision,
  PermissionRequestDecision,
  StopDecision,
  ContextInjection,
  NoOp,
)

export type HookDecision = Schema.Schema.Type<typeof HookDecision>

export const DECISION_SCHEMAS = {
  PreToolUseDecision,
  PermissionRequestDecision,
  StopDecision,
  ContextInjection,
  NoOp,
} as const

export const SAFE_DEFAULT: HookDecision = {}
