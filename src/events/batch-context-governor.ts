import { Effect } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { NO_DECISION } from "../schema/decisions.ts"
import { SessionState, type VerificationStatus } from "../services/session-state.ts"
import { reportHookFailure } from "../services/hook-failure.ts"
import {
  isSourceCollectionTool,
  isSuccessfulToolResponse,
  isUsableSourceToolResponse,
  isVerificationCommand,
  urlsFromToolInput,
  urlsFromToolResponse,
} from "../policies/tool-evidence.ts"

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "Update"])
const READ_TOOLS = new Set(["Read"])

const MAX_INJECT = 500

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, Math.max(0, max - 3)) + "..."

const filePathFromInput = (input: unknown): string | null => {
  if (typeof input !== "object" || input === null) return null
  const fp = (input as { file_path?: unknown }).file_path
  return typeof fp === "string" ? fp : null
}

const commandFromInput = (input: unknown): string | null => {
  if (typeof input !== "object" || input === null) return null
  const c = (input as { command?: unknown }).command
  return typeof c === "string" ? c : null
}

interface BatchSummary {
  readonly readsAdded: number
  readonly editsAdded: number
  readonly commandsAdded: number
  readonly commandsFailedAdded: number
  readonly testsAdded: number
  readonly verification: VerificationStatus
  readonly nextAction: string | null
}

export const handlePostToolBatch = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, SessionState> =>
  Effect.gen(function* () {
    if (payload._tag !== "PostToolBatch") return NO_DECISION
    const state = yield* SessionState
    const sessionId = payload.session_id

    const filesRead: string[] = []
    const filesChanged: string[] = []
    const commandsRun: string[] = []
    const commandsFailed: string[] = []
    const testsRun: string[] = []
    const urlsCollected: string[] = []
    let verification: VerificationStatus = "none"
    let sawVerify = false
    let sawVerifyFail = false

    for (const entry of payload.tools) {
      const success = isSuccessfulToolResponse(entry.tool_response)
      if (READ_TOOLS.has(entry.tool_name)) {
        const fp = filePathFromInput(entry.tool_input)
        if (fp !== null) filesRead.push(fp)
      } else if (EDIT_TOOLS.has(entry.tool_name)) {
        const fp = filePathFromInput(entry.tool_input)
        if (fp !== null && success) filesChanged.push(fp)
      } else if (entry.tool_name === "Bash") {
        const cmd = commandFromInput(entry.tool_input)
        if (cmd !== null) {
          commandsRun.push(cmd)
          if (!success) commandsFailed.push(cmd)
          if (isVerificationCommand(cmd)) {
            sawVerify = true
            testsRun.push(cmd)
            if (!success) sawVerifyFail = true
          }
        }
      } else if (
        isSourceCollectionTool(entry.tool_name) &&
        isUsableSourceToolResponse(entry.tool_response)
      ) {
        for (const u of urlsFromToolInput(entry.tool_input)) urlsCollected.push(u)
        for (const u of urlsFromToolResponse(entry.tool_response)) urlsCollected.push(u)
      }
    }

    if (sawVerify) verification = sawVerifyFail ? "failed" : "passed"

    // Persist into ledger (best-effort; never fail the hook).
    // Coalesce all appends into a single read/modify/write via appendBatch.
    type BatchKey =
      | "files_read"
      | "files_changed"
      | "commands_run"
      | "commands_failed"
      | "tests_run"
      | "source_urls"
    const batchEntries: Array<{ readonly key: BatchKey; readonly value: string }> = []
    for (const f of filesRead) batchEntries.push({ key: "files_read", value: f })
    for (const f of filesChanged) batchEntries.push({ key: "files_changed", value: f })
    for (const c of commandsRun) batchEntries.push({ key: "commands_run", value: c })
    for (const c of commandsFailed) batchEntries.push({ key: "commands_failed", value: c })
    for (const t of testsRun) batchEntries.push({ key: "tests_run", value: t })
    for (const u of urlsCollected) batchEntries.push({ key: "source_urls", value: u })
    if (batchEntries.length > 0) {
      yield* state
        .appendBatch(sessionId, batchEntries)
        .pipe(
          Effect.timeout("500 millis"),
          Effect.catchAll((cause) =>
            reportHookFailure({
              kind: "state_write_failed",
              event: "PostToolBatch",
              sessionId,
              cause,
              hookSafe: true,
              context: { op: "session-state.appendBatch" },
            }),
          ),
        )
    }

    let nextAction: string | null = null
    if (verification === "failed") {
      nextAction = "Read the failure output and fix the failing assertion."
    } else if (filesChanged.length > 0 && verification !== "passed") {
      nextAction = "Run the smallest relevant test/typecheck for the changed files."
    } else if (commandsFailed.length > 0) {
      nextAction = "Investigate the failed command before continuing."
    } else if (filesRead.length > 0 && filesChanged.length === 0) {
      nextAction = "Decide on the next concrete edit based on what was read."
    }

    if (verification !== "none" || nextAction !== null) {
      yield* state
        .update(sessionId, {
          verification_status: verification,
          next_required_action: nextAction,
        })
        .pipe(
          Effect.catchAll((cause) =>
            reportHookFailure({
              kind: "state_write_failed",
              event: "PostToolBatch",
              sessionId,
              cause,
              hookSafe: true,
              context: { op: "session-state.update" },
            }),
          ),
        )
    }

    const summary: BatchSummary = {
      readsAdded: filesRead.length,
      editsAdded: filesChanged.length,
      commandsAdded: commandsRun.length,
      commandsFailedAdded: commandsFailed.length,
      testsAdded: testsRun.length,
      verification,
      nextAction,
    }

    const parts: string[] = []
    parts.push(
      `Batch: ${summary.readsAdded} read, ${summary.editsAdded} edit, ${summary.commandsAdded} cmd (${summary.commandsFailedAdded} failed), ${summary.testsAdded} verify.`,
    )
    parts.push(`Verification: ${summary.verification}.`)
    if (summary.nextAction !== null) parts.push(`Next: ${summary.nextAction}`)
    const additionalContext = truncate(parts.join(" "), MAX_INJECT)

    const out: HookDecision = {
      hookSpecificOutput: {
        hookEventName: "PostToolBatch",
        additionalContext,
      },
    }
    return out
  })
