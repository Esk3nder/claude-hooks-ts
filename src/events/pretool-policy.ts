import { Effect, Option, Schema } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { NO_DECISION } from "../schema/decisions.ts"
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
import { evaluateTddGate } from "../policies/tdd-gate.ts"
import {
  activeWorkerCount,
  evaluateWorkerMandatoryGate,
} from "../policies/worker-mandatory.ts"
import { safeResolvePath } from "../services/path-resolution.ts"
import { evaluateWorkerTaskPrompt } from "../policies/worker-contract.ts"
import { evaluateWorkerToolPermission } from "../policies/worker-permissions.ts"
import { mutablePathFromInput } from "../policies/write-class.ts"
import { SessionState } from "../services/session-state.ts"
import { loadRuntimeConfig } from "../services/runtime-config.ts"
import { reportHookFailure } from "../services/hook-failure.ts"
import { WorkerRuns } from "../services/worker-runs.ts"
import { countActiveRuns } from "../services/worker-aggregation.ts"

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

interface ToolEvaluation {
  readonly decision: PolicyDecision
  readonly decodeFailure?: string
}

const toolEvaluation = (
  decision: PolicyDecision,
  decodeFailure?: string,
): ToolEvaluation => ({
  decision,
  ...(decodeFailure === undefined ? {} : { decodeFailure }),
})

const evaluateBash = (input: unknown): ToolEvaluation => {
  const decoded = Schema.decodeUnknownEither(BashInput)(input)
  if (decoded._tag === "Left") {
    return toolEvaluation(
      {
        kind: "ask",
        reason: "Bash input did not match expected schema; confirming for safety.",
      },
      "bash input schema mismatch",
    )
  }
  return toolEvaluation(evaluateDestructiveCommand(decoded.right.command))
}

/**
 * Decode a Bash tool input and return the `command` string when it
 * validates, else `undefined`. Used by callers that need the Bash
 * command but tolerate malformed inputs without an `ask` (the
 * downstream gate decides — typically passthrough when no command).
 * Mirrors `evaluateBash` for input handling consistency (PR #72
 * self-review non-blocker #3 — replaces an inline `as` cast).
 */
const bashCommandIfValid = (input: unknown): string | undefined => {
  const decoded = Schema.decodeUnknownEither(BashInput)(input)
  return decoded._tag === "Right" ? decoded.right.command : undefined
}

const evaluateRead = (input: unknown): ToolEvaluation => {
  const decoded = Schema.decodeUnknownEither(ReadInput)(input)
  if (decoded._tag === "Left") {
    return toolEvaluation(
      {
        kind: "ask",
        reason:
          "Read input did not match expected schema; confirming for safety so secret-path checks aren't silently bypassed.",
      },
      "read input schema mismatch",
    )
  }
  return toolEvaluation(
    reducePolicies(collectPathPolicies(decoded.right.file_path, "read")),
  )
}

const evaluateEditOrWrite = (input: unknown): ToolEvaluation => {
  const tryEdit = Schema.decodeUnknownEither(EditInput)(input)
  if (tryEdit._tag === "Right") {
    return toolEvaluation(
      reducePolicies(collectPathPolicies(tryEdit.right.file_path, "write")),
    )
  }
  const tryWrite = Schema.decodeUnknownEither(WriteInput)(input)
  if (tryWrite._tag === "Right") {
    return toolEvaluation(
      reducePolicies(collectPathPolicies(tryWrite.right.file_path, "write")),
    )
  }
  const tryMulti = Schema.decodeUnknownEither(MultiEditInput)(input)
  if (tryMulti._tag === "Right") {
    return toolEvaluation(
      reducePolicies(collectPathPolicies(tryMulti.right.file_path, "write")),
    )
  }
  return toolEvaluation(
    {
      kind: "ask",
      reason:
        "Edit/Write input did not match any known schema; confirming for safety so write-path checks aren't silently bypassed.",
    },
    "edit/write input matched no known schema",
  )
}

/**
 * Enforcement-plane P0 #2: Update / NotebookEdit dispatch.
 * Pre-fix: these fell through to passthrough, bypassing every write-
 * path policy (secret-paths, settings-self-protection, generated-files,
 * lockfile-paths, protected-paths). Now: extract `file_path` (Update) or
 * `notebook_path` (NotebookEdit) via the shared `mutablePathFromInput`
 * helper and run the same reducer Edit/Write/MultiEdit use.
 *
 * Kept separate from `evaluateEditOrWrite` so the existing fail-closed
 * posture for malformed Edit/Write/MultiEdit inputs (ask, not silent
 * passthrough) is preserved exactly.
 */
const evaluateUpdateOrNotebookEdit = (input: unknown): ToolEvaluation => {
  const extracted = mutablePathFromInput(input)
  if (extracted !== null) {
    return toolEvaluation(
      reducePolicies(collectPathPolicies(extracted, "write")),
    )
  }
  return toolEvaluation(
    {
      kind: "ask",
      reason:
        "Update/NotebookEdit input did not carry a recognizable file_path or notebook_path; confirming for safety so write-path checks aren't silently bypassed.",
    },
    "update/notebook-edit input missing path",
  )
}

const evaluateForToolWithFailure = (
  toolName: string,
  toolInput: unknown,
): ToolEvaluation => {
  switch (toolName) {
    case "Bash":
      return evaluateBash(toolInput)
    case "Read":
      return evaluateRead(toolInput)
    case "Edit":
    case "Write":
    case "MultiEdit":
      return evaluateEditOrWrite(toolInput)
    case "Update":
    case "NotebookEdit":
      // Enforcement-plane P0 #2.
      return evaluateUpdateOrNotebookEdit(toolInput)
    default:
      return toolEvaluation({ kind: "passthrough" })
  }
}

const evaluateForTool = (
  toolName: string,
  toolInput: unknown,
): PolicyDecision => evaluateForToolWithFailure(toolName, toolInput).decision

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
      return NO_DECISION
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
    if (payload._tag !== "PreToolUse") return NO_DECISION

    // Engagement gate (runs FIRST among PreToolUse policies). When the
    // session was classified ALGORITHM tier ≥ 3 and the expected ISA file
    // does not exist on disk yet, deny non-ISA implementation tools so the
    // model cannot silently proceed without scaffolding the artifact the
    // prompt-router directive demanded.
    //
    // Escape hatch: RuntimeConfig.isaPretoolGateDisabled bypasses this gate
    // entirely. Operational safety — if path parsing or state hydration goes
    // wrong, you need a way out without editing source under a blocked tool
    // regime.
    const config = yield* loadRuntimeConfig
    if (!config.isaPretoolGateDisabled) {
      const state = yield* SessionState
      const sid = payload.session_id
      const record = yield* state
        .get(sid)
        .pipe(
          Effect.catchAll((cause) =>
            reportHookFailure({
              kind: "state_read_failed",
              event: "PreToolUse",
              sessionId: sid,
              cause,
              hookSafe: true,
              context: { op: "session-state.get", tool_name: payload.tool_name, cwd: payload.cwd },
            }).pipe(Effect.as(null)),
          ),
        )
      if (record !== null) {
        // Distinguish two roots:
        //  - currentCwd: the shell cwd at hook time (mutable; tracks Bash cd).
        //    Used ONLY for resolving the tool's own input path, because the
        //    model writes relative paths against the current shell cwd.
        //  - sessionRoot: the frozen project root chosen at engagement
        //    creation. Used for everything ISA-identity related. The gate
        //    itself owns accepted-path construction from these inputs.
        const currentCwd =
          typeof payload.cwd === "string" && payload.cwd.length > 0
            ? payload.cwd
            : process.cwd()
        const sessionRoot = record.session_root ?? currentCwd
        const engagementVerdict = evaluateEngagementGate({
          currentCwd,
          sessionRoot,
          record,
          toolName: payload.tool_name,
          toolInput: payload.tool_input,
        })
        if (engagementVerdict.kind !== "passthrough") {
          return toHookDecision(engagementVerdict)
        }
        // US-1: TDD-first gate. Default off (tddGateEnabled=false). When
        // enabled, blocks Write/Edit/MultiEdit/NotebookEdit on a non-test
        // file under src/** unless a companion test exists on disk OR was
        // touched in this session. Bootstrap-batch escape: if the test
        // file was created/edited earlier in the same session (i.e.
        // appears in record.files_changed), the implementation write is
        // allowed.
        if (config.tddGateEnabled) {
          const inputFp =
            typeof payload.tool_input === "object" && payload.tool_input !== null
              ? (payload.tool_input as { file_path?: unknown }).file_path
              : undefined
          const resolvedFilePath = safeResolvePath(currentCwd, inputFp)
          const tddVerdict = evaluateTddGate(
            {
              enabled: true,
              toolName: payload.tool_name,
              resolvedFilePath,
              filesChangedInSession: record.files_changed,
            },
            currentCwd,
          )
          if (tddVerdict.kind !== "passthrough") {
            return toHookDecision(tddVerdict)
          }
        }
        // US-2: mandatory worker delegation. Off by default. When the
        // session is ALGORITHM tier ≥ E4 and the model attempts a direct
        // Write/Edit/etc. with NO active worker (subagent_starts ===
        // subagent_stops), the gate either asks ("recommend") or denies
        // ("strict"). A live worker grants passthrough. Worker sessions
        // (CLAUDE_HOOKS_WORKER_ID set) are always passthrough.
        if (config.workerMandatoryMode !== "off") {
          // Enforcement-plane P0 #6: extract the Bash command (when the
          // tool is Bash) and pass it so worker-mandatory can detect
          // heredoc-style writes. Without this, `cat > src/x.ts <<EOF`
          // would have bypassed strict mode entirely. Uses the shared
          // schema-decode helper so malformed Bash inputs aren't
          // accidentally treated as a string (PR #72 review #3).
          const bashCommandForGate =
            payload.tool_name === "Bash"
              ? bashCommandIfValid(payload.tool_input)
              : undefined
          // P0-1: derive the active-worker signal from the worker-runs
          // ledger when the service is available (production wiring and
          // any test that provides it). Falls back to the legacy
          // `subagent_starts.length - subagent_stops.length` delta only
          // when WorkerRuns is absent from context (older targeted unit
          // tests). The legacy signal is corrupt by design: a dropped
          // SubagentStop append leaves `starts > stops` forever, and
          // worker-mandatory returns `allow` whenever the count is
          // positive — so the parent silently regains direct-write
          // ability for the rest of the session. The runs ledger has
          // terminal-status semantics maintained atomically by
          // `recordWorkerStop`, so it does not suffer the same drift.
          const runsService = yield* Effect.serviceOption(WorkerRuns)
          let derivedActiveCount: number
          if (Option.isSome(runsService)) {
            const runsResult = yield* Effect.either(
              runsService.value.forSession(payload.session_id),
            )
            if (runsResult._tag === "Right") {
              derivedActiveCount = countActiveRuns(runsResult.right)
            } else {
              // Ledger read failed (filesystem error, malformed tail).
              // Fall back to starts-stops rather than zeroing the count
              // (which would deny *all* direct writes during a transient
              // ledger outage). Report via hook-failure for observability.
              yield* reportHookFailure({
                kind: "state_read_failed",
                event: "PreToolUse",
                sessionId: payload.session_id,
                cause: runsResult.left,
                hookSafe: true,
                context: {
                  op: "worker-runs.forSession",
                  stage: "worker-mandatory active-count derivation",
                  tool_name: payload.tool_name,
                },
              })
              derivedActiveCount = activeWorkerCount({
                starts: record.subagent_starts.length,
                stops: record.subagent_stops.length,
              })
            }
          } else {
            derivedActiveCount = activeWorkerCount({
              starts: record.subagent_starts.length,
              stops: record.subagent_stops.length,
            })
          }
          const verdict = evaluateWorkerMandatoryGate({
            mode: config.workerMandatoryMode,
            toolName: payload.tool_name,
            lastTier: record.last_tier,
            activeWorkerCount: derivedActiveCount,
            // CLAUDE_HOOKS_WORKER_ID is set by the harness on subagent
            // processes; when present, this PreToolUse is happening
            // inside a worker session and the gate must short-circuit.
            isWorkerSession: Option.isSome(config.workerIdOverride),
            ...(bashCommandForGate !== undefined
              ? { bashCommand: bashCommandForGate }
              : {}),
          })
          if (verdict.kind !== "passthrough") {
            return toHookDecision(verdict)
          }
        }
      }
    }

    const workerToolDecision = yield* evaluateWorkerToolPermission(payload)
    if (workerToolDecision.kind !== "passthrough") {
      return toHookDecision(workerToolDecision)
    }

    const toolEvaluationResult = evaluateForToolWithFailure(
      payload.tool_name,
      payload.tool_input,
    )
    const result = toolEvaluationResult.decision
    const base = toHookDecision(result)
    if (toolEvaluationResult.decodeFailure !== undefined) {
      yield* reportHookFailure({
        kind: "payload_decode_failed",
        event: "PreToolUse",
        sessionId: payload.session_id,
        cause: toolEvaluationResult.decodeFailure,
        fallbackDecision: base,
        hookSafe: true,
        context: {
          stage: "tool_input",
          tool_name: payload.tool_name,
          cwd: payload.cwd,
        },
      })
    }
    // Only attach updatedInput when not denied/asked.
    if (result.kind === "deny" || result.kind === "ask") return base

    const workerPrompt = evaluateWorkerTaskPrompt(
      payload.tool_name,
      payload.tool_input,
    )
    if (workerPrompt.kind === "ask") {
      return decision("ask", workerPrompt.reason)
    }
    if (workerPrompt.kind === "rewrite") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "allow" as const,
          permissionDecisionReason: workerPrompt.reason,
          updatedInput: workerPrompt.updatedInput,
        },
      }
    }

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
