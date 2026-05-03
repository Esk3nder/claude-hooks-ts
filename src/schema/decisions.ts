import { Schema } from "effect"

export const PreToolUseDecision = Schema.Struct({
  hookSpecificOutput: Schema.Struct({
    hookEventName: Schema.Literal("PreToolUse"),
    permissionDecision: Schema.Literal("allow", "deny", "ask"),
    permissionDecisionReason: Schema.String,
    updatedInput: Schema.optional(Schema.Unknown),
  }),
})

/**
 * PermissionRequest output schema, per the official Claude Code spec.
 *
 * The shape is `{ hookSpecificOutput: { hookEventName: "PermissionRequest",
 * decision: { behavior, message?, updatedInput?, updatedPermissions? } } }`.
 *
 * Note: `behavior` is "allow" | "deny" only. There is no "ask" — emitting an
 * empty no-op (`{}`) is what causes Claude Code to fall back to its normal
 * permission dialog (i.e. the implicit "ask").
 */
export const PermissionRequestDecision = Schema.Struct({
  hookSpecificOutput: Schema.Struct({
    hookEventName: Schema.Literal("PermissionRequest"),
    decision: Schema.Struct({
      behavior: Schema.Literal("allow", "deny"),
      updatedInput: Schema.optional(Schema.Unknown),
      updatedPermissions: Schema.optional(Schema.Array(Schema.Unknown)),
      message: Schema.optional(Schema.String),
    }),
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
