import { Effect } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { NO_DECISION } from "../schema/decisions.ts"
import { SessionState, type VerificationStatus } from "../services/session-state.ts"

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "Update"])
const READ_TOOLS = new Set(["Read"])
const VERIFY_TOKENS = [
  "test",
  "tsc",
  "typecheck",
  "lint",
  "eslint",
  "ruff",
  "pytest",
  "cargo test",
  "go test",
  "bun test",
  "vitest",
  "jest",
]

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


const URL_RE = /https?:\/\/[^\s"'<>)]+/g

const urlsFromInput = (input: unknown): ReadonlyArray<string> => {
  if (typeof input !== "object" || input === null) return []
  const obj = input as { url?: unknown; query?: unknown }
  const out: string[] = []
  if (typeof obj.url === "string") out.push(obj.url)
  if (typeof obj.query === "string") {
    const m = obj.query.match(URL_RE)
    if (m) for (const u of m) out.push(u)
  }
  return out
}

const urlsFromResponse = (response: unknown): ReadonlyArray<string> => {
  if (response === undefined || response === null) return []
  let text = ""
  if (typeof response === "string") text = response
  else {
    try { text = JSON.stringify(response) } catch { return [] }
  }
  const m = text.match(URL_RE)
  return m ? Array.from(new Set(m)) : []
}

const successFromTool = (entry: {
  readonly tool_response?: unknown
}): boolean => {
  const r = entry.tool_response
  if (r === undefined || r === null) return true
  if (typeof r !== "object") return true
  const obj = r as { success?: unknown; error?: unknown; exitCode?: unknown; exit_code?: unknown }
  if (obj.success === false) return false
  if (obj.error !== undefined && obj.error !== null) return false
  if (typeof obj.exitCode === "number" && obj.exitCode !== 0) return false
  if (typeof obj.exit_code === "number" && obj.exit_code !== 0) return false
  return true
}

const isVerifyCommand = (cmd: string): boolean => {
  const lower = cmd.toLowerCase()
  return VERIFY_TOKENS.some((tok) => lower.includes(tok))
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
      const success = successFromTool(entry)
      if (READ_TOOLS.has(entry.tool_name)) {
        const fp = filePathFromInput(entry.tool_input)
        if (fp !== null) filesRead.push(fp)
      } else if (EDIT_TOOLS.has(entry.tool_name)) {
        const fp = filePathFromInput(entry.tool_input)
        if (fp !== null) filesChanged.push(fp)
      } else if (entry.tool_name === "Bash") {
        const cmd = commandFromInput(entry.tool_input)
        if (cmd !== null) {
          commandsRun.push(cmd)
          if (!success) commandsFailed.push(cmd)
          if (isVerifyCommand(cmd)) {
            sawVerify = true
            testsRun.push(cmd)
            if (!success) sawVerifyFail = true
          }
        }
      } else if (entry.tool_name === "WebFetch" || entry.tool_name === "WebSearch") {
        for (const u of urlsFromInput(entry.tool_input)) urlsCollected.push(u)
        for (const u of urlsFromResponse(entry.tool_response)) urlsCollected.push(u)
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
          Effect.orElseSucceed(() => undefined),
        )
    }

    let nextAction: string | null = null
    if (filesChanged.length > 0 && verification !== "passed") {
      nextAction = "Run the smallest relevant test/typecheck for the changed files."
    } else if (verification === "failed") {
      nextAction = "Read the failure output and fix the failing assertion."
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
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
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
