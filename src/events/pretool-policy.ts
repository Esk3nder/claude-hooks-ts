import { Effect, Schema } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import {
  BashInput,
  EditInput,
  MultiEditInput,
  ReadInput,
  WriteInput,
} from "../schema/tool-inputs.ts"
import type { PolicyDecision } from "../policies/types.ts"
import { reducePolicies } from "../policies/types.ts"
import { evaluateSecretPath } from "../policies/secret-paths.ts"
import { evaluateDestructiveCommand } from "../policies/destructive-commands.ts"
import { evaluateProtectedPath } from "../policies/protected-paths.ts"
import { evaluateSettingsSelfProtection } from "../policies/settings-self-protection.ts"
import { evaluateGeneratedFile } from "../policies/generated-files.ts"
import { evaluateLockfile } from "../policies/lockfile-paths.ts"

const decision = (
  permissionDecision: "allow" | "deny" | "ask",
  reason: string,
): HookDecision => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision,
    permissionDecisionReason: reason,
  },
})

const collectPathPolicies = (
  filePath: string,
  context: "read" | "write",
): ReadonlyArray<PolicyDecision> => {
  const out: PolicyDecision[] = []
  if (context === "read") {
    out.push(evaluateSecretPath(filePath))
  }
  if (context === "write") {
    out.push(evaluateSettingsSelfProtection(filePath))
    out.push(evaluateGeneratedFile(filePath))
    out.push(evaluateLockfile(filePath))
    out.push(evaluateProtectedPath(filePath))
    // Writing to a known secret path also denies (e.g. don't overwrite .env).
    out.push(evaluateSecretPath(filePath))
  }
  return out
}

const evaluateBash = (input: unknown): PolicyDecision => {
  const decoded = Schema.decodeUnknownEither(BashInput)(input)
  if (decoded._tag === "Left") {
    return {
      kind: "ask",
      reason: "Bash input did not match expected schema; confirming for safety.",
    }
  }
  return evaluateDestructiveCommand(decoded.right.command)
}

const evaluateRead = (input: unknown): PolicyDecision => {
  const decoded = Schema.decodeUnknownEither(ReadInput)(input)
  if (decoded._tag === "Left") return { kind: "passthrough" }
  return reducePolicies(collectPathPolicies(decoded.right.file_path, "read"))
}

const evaluateEditOrWrite = (input: unknown): PolicyDecision => {
  const tryEdit = Schema.decodeUnknownEither(EditInput)(input)
  if (tryEdit._tag === "Right") {
    return reducePolicies(collectPathPolicies(tryEdit.right.file_path, "write"))
  }
  const tryWrite = Schema.decodeUnknownEither(WriteInput)(input)
  if (tryWrite._tag === "Right") {
    return reducePolicies(collectPathPolicies(tryWrite.right.file_path, "write"))
  }
  const tryMulti = Schema.decodeUnknownEither(MultiEditInput)(input)
  if (tryMulti._tag === "Right") {
    return reducePolicies(collectPathPolicies(tryMulti.right.file_path, "write"))
  }
  return { kind: "passthrough" }
}

const evaluateForTool = (
  toolName: string,
  toolInput: unknown,
): PolicyDecision => {
  switch (toolName) {
    case "Bash":
      return evaluateBash(toolInput)
    case "Read":
      return evaluateRead(toolInput)
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "Update":
      return evaluateEditOrWrite(toolInput)
    default:
      return { kind: "passthrough" }
  }
}

/** Convert internal PolicyDecision → wire-format HookDecision. */
export const toHookDecision = (d: PolicyDecision): HookDecision => {
  switch (d.kind) {
    case "deny":
      return decision("deny", d.reason)
    case "ask":
      return decision("ask", d.reason)
    case "allow":
      return decision("allow", d.reason ?? "policy allow")
    case "passthrough":
      return SAFE_DEFAULT
  }
}

export const handlePreToolUse = (
  payload: HookPayload,
): Effect.Effect<HookDecision> =>
  Effect.sync(() => {
    if (payload._tag !== "PreToolUse") return SAFE_DEFAULT
    const result = evaluateForTool(payload.tool_name, payload.tool_input)
    return toHookDecision(result)
  })

// Re-export for tests.
export { evaluateForTool }
