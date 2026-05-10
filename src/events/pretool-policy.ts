import { Effect, Schema } from "effect"
import { existsSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
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
import { shouldRewrite, rewriteTestCommand } from "../policies/test-output-rewrite.ts"
import { evaluateEngagementGate } from "../policies/engagement-gate.ts"
import { SessionState } from "../services/session-state.ts"

const ENGAGEMENT_BYPASS_ENV = "CLAUDE_HOOKS_DISABLE_ISA_PRETOOL_GATE"

/**
 * Normalize a path against cwd so the engagement gate compares apples
 * to apples. Steps:
 *   1. Resolve against cwd → absolute path with `..` collapsed.
 *   2. If the path or any ancestor exists, follow symlinks via realpath
 *      on the deepest existing ancestor and re-attach the unresolved
 *      tail. This catches symlink-based bypasses where the path
 *      *string* looks safe but the *target* points outside the allowed
 *      area.
 *
 * Returns null if input is not a non-empty string.
 */
const safeResolvePath = (cwd: string, input: unknown): string | null => {
  if (typeof input !== "string" || input.length === 0) return null
  const absolute = isAbsolute(input) ? input : resolve(cwd, input)
  // Find the deepest existing ancestor and realpath that.
  let parent = absolute
  const tail: string[] = []
  while (parent !== dirname(parent)) {
    if (existsSync(parent)) break
    tail.unshift(parent.split("/").pop() ?? "")
    parent = dirname(parent)
  }
  if (existsSync(parent)) {
    try {
      const real = realpathSync(parent)
      return tail.length === 0 ? real : [real, ...tail].join("/")
    } catch {
      // realpath can fail on EPERM / ELOOP — fall through to the
      // resolved-but-not-realpathed form. The gate still rejects on
      // string equality, so this errs toward denying rather than
      // accidentally allowing a path that looked safe pre-realpath.
    }
  }
  return absolute
}

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
    process.stderr.write("pretool-policy: bash input schema mismatch\n")
    return {
      kind: "ask",
      reason: "Bash input did not match expected schema; confirming for safety.",
    }
  }
  return evaluateDestructiveCommand(decoded.right.command)
}

const evaluateRead = (input: unknown): PolicyDecision => {
  const decoded = Schema.decodeUnknownEither(ReadInput)(input)
  if (decoded._tag === "Left") {
    process.stderr.write("pretool-policy: read input schema mismatch\n")
    return {
      kind: "ask",
      reason:
        "Read input did not match expected schema; confirming for safety so secret-path checks aren't silently bypassed.",
    }
  }
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
  process.stderr.write(
    "pretool-policy: edit/write input matched no known schema\n",
  )
  return {
    kind: "ask",
    reason:
      "Edit/Write input did not match any known schema; confirming for safety so write-path checks aren't silently bypassed.",
  }
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

const tryRewriteBashInput = (
  toolName: string,
  toolInput: unknown,
): { readonly command: string } | null => {
  if (toolName !== "Bash") return null
  const decoded = Schema.decodeUnknownEither(BashInput)(toolInput)
  if (decoded._tag === "Left") return null
  const cmd = decoded.right.command
  if (!shouldRewrite(cmd)) return null
  return { command: rewriteTestCommand(cmd) }
}

export const handlePreToolUse = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, SessionState> => {
  const toolName = payload._tag === "PreToolUse" ? payload.tool_name : "<n/a>"
  return Effect.gen(function* () {
    if (payload._tag !== "PreToolUse") return SAFE_DEFAULT

    // Engagement gate (runs FIRST among PreToolUse policies). When the
    // session was classified ALGORITHM tier ≥ 3 and the expected ISA file
    // does not exist on disk yet, deny non-ISA implementation tools so the
    // model cannot silently proceed without scaffolding the artifact the
    // prompt-router directive demanded.
    //
    // Escape hatch: setting CLAUDE_HOOKS_DISABLE_ISA_PRETOOL_GATE=1 in the
    // hook environment bypasses this gate entirely. Operational safety —
    // if path parsing or state hydration goes wrong, you need a way out
    // without editing source under a blocked tool regime.
    if (process.env[ENGAGEMENT_BYPASS_ENV] !== "1") {
      const state = yield* SessionState
      const record = yield* state
        .get(payload.session_id)
        .pipe(Effect.catchAll(() => Effect.succeed(null)))
      if (
        record !== null &&
        record.engagement_required &&
        record.expected_isa_path !== null
      ) {
        const cwd =
          typeof payload.cwd === "string" && payload.cwd.length > 0
            ? payload.cwd
            : process.cwd()
        // expected_isa_path is stored project-relative; the wrapper
        // computes the absolute and realpath-normalized forms so the
        // gate can compare strings without worrying about `..`,
        // symlinks, or relative-vs-absolute mismatches.
        const expectedAbsolute = safeResolvePath(cwd, record.expected_isa_path)
        const expectedDir =
          expectedAbsolute !== null ? dirname(expectedAbsolute) : null
        const expectedIsaExists =
          expectedAbsolute !== null && existsSync(expectedAbsolute)
        // Project ISA at <cwd>/ISA.md is accepted for Edit/MultiEdit
        // (aligning with the Stop gate) IFF it already exists. We do
        // NOT permit creating a fresh project ISA via Write — the
        // directive promised a deterministic location.
        const projectIsaAbsolute = safeResolvePath(cwd, "ISA.md")
        const projectIsaExists =
          projectIsaAbsolute !== null && existsSync(projectIsaAbsolute)

        const acceptedWritePaths =
          expectedAbsolute !== null ? [expectedAbsolute] : []
        const acceptedEditPaths =
          projectIsaExists && projectIsaAbsolute !== null
            ? [...acceptedWritePaths, projectIsaAbsolute]
            : acceptedWritePaths
        // Bash mkdir comparison is string-based (no path resolution),
        // so accept both the relative form the model would naturally
        // type and the absolute form a tool might produce.
        const acceptedMkdirDirs: string[] = []
        if (expectedDir !== null) acceptedMkdirDirs.push(expectedDir)
        const expectedDirRelative = dirname(record.expected_isa_path)
        const pushIfNew = (d: string): void => {
          if (d.length > 0 && !acceptedMkdirDirs.includes(d)) {
            acceptedMkdirDirs.push(d)
          }
        }
        // The model can spell relative paths several common ways. Accept
        // the bare relative form AND a leading `./` form (`./foo/bar`),
        // since the engagement-gate's whitelist is exact-string.
        pushIfNew(expectedDirRelative)
        if (
          expectedDirRelative !== "." &&
          !expectedDirRelative.startsWith("./") &&
          !expectedDirRelative.startsWith("/")
        ) {
          pushIfNew(`./${expectedDirRelative}`)
        }
        const anyAcceptedIsaExists =
          expectedIsaExists || projectIsaExists

        const inputFp =
          typeof payload.tool_input === "object" && payload.tool_input !== null
            ? (payload.tool_input as { file_path?: unknown }).file_path
            : undefined
        const resolvedToolFilePath = safeResolvePath(cwd, inputFp)

        const engagementVerdict = evaluateEngagementGate({
          engagement_required: record.engagement_required,
          anyAcceptedIsaExists,
          acceptedWritePaths,
          acceptedEditPaths,
          acceptedMkdirDirs,
          displayIsaPath: record.expected_isa_path,
          displayMkdirDir: expectedDir,
          resolvedToolFilePath,
          toolName: payload.tool_name,
          toolInput: payload.tool_input,
        })
        if (engagementVerdict.kind === "deny") {
          return toHookDecision(engagementVerdict)
        }
      }
    }

    const result = evaluateForTool(payload.tool_name, payload.tool_input)
    const base = toHookDecision(result)
    // Only attach updatedInput when not denied/asked.
    if (result.kind === "deny" || result.kind === "ask") return base
    const rewrite = tryRewriteBashInput(payload.tool_name, payload.tool_input)
    if (rewrite === null) return base
    const inputObj =
      typeof payload.tool_input === "object" && payload.tool_input !== null
        ? (payload.tool_input as Record<string, unknown>)
        : {}
    const updatedInput = { ...inputObj, command: rewrite.command }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "allow" as const,
        permissionDecisionReason:
          result.kind === "allow"
            ? (result.reason ?? "policy allow")
            : "Test/build command rewritten to failure-only output.",
        updatedInput,
      },
    }
  }).pipe(
    Effect.withSpan("policy.evaluate", {
      attributes: { tool: toolName },
    }),
  )
}

// Re-export for tests.
export { evaluateForTool }
