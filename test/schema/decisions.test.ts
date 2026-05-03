import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  HookDecision,
  PreToolUseDecision,
  PermissionRequestDecision,
  StopDecision,
  ContextInjection,
  NoOp,
} from "../../src/schema/decisions.ts"

const cases: Array<{ name: string; schema: Schema.Schema<unknown, unknown, never>; value: unknown }> = [
  {
    name: "PreToolUseDecision",
    schema: PreToolUseDecision as unknown as Schema.Schema<unknown, unknown, never>,
    value: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "blocked",
      },
    },
  },
  {
    name: "StopDecision",
    schema: StopDecision as unknown as Schema.Schema<unknown, unknown, never>,
    value: { decision: "block", reason: "tests failing" },
  },
  {
    name: "ContextInjection",
    schema: ContextInjection as unknown as Schema.Schema<unknown, unknown, never>,
    value: {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "ctx",
      },
    },
  },
  {
    name: "PermissionRequestDecision-allow",
    schema: PermissionRequestDecision as unknown as Schema.Schema<unknown, unknown, never>,
    value: {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    },
  },
  {
    name: "PermissionRequestDecision-deny-with-message",
    schema: PermissionRequestDecision as unknown as Schema.Schema<unknown, unknown, never>,
    value: {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "prior denial" },
      },
    },
  },
  {
    name: "PreToolUseDecision-with-updatedInput",
    schema: PreToolUseDecision as unknown as Schema.Schema<unknown, unknown, never>,
    value: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "rewritten",
        updatedInput: { command: "npm test 2>&1 | head -200" },
      },
    },
  },
  {
    name: "NoOp",
    schema: NoOp as unknown as Schema.Schema<unknown, unknown, never>,
    value: {},
  },
]

describe("HookDecision schemas", () => {
  for (const c of cases) {
    test(`round-trip: ${c.name}`, () => {
      const decoded = Schema.decodeUnknownSync(c.schema)(c.value)
      const encoded = Schema.encodeSync(c.schema)(decoded)
      const reDecoded = Schema.decodeUnknownSync(c.schema)(encoded)
      expect(reDecoded).toEqual(decoded)
    })

    test(`union accepts: ${c.name}`, () => {
      const decoded = Schema.decodeUnknownSync(HookDecision)(c.value)
      expect(decoded).toBeDefined()
    })
  }
})
