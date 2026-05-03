import { Effect } from "effect"
import * as path from "node:path"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { FileSystem } from "../services/filesystem.ts"
import { SessionState, EMPTY_SESSION_STATE } from "../services/session-state.ts"
import { Project } from "../services/project.ts"

const MAX_INJECT = 1024
const MAX_LIST = 20

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, Math.max(0, max - 3)) + "..."

const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9._-]/g, "_")

export const handlePreCompact = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, FileSystem | SessionState | Project> =>
  Effect.gen(function* () {
    if (payload._tag !== "PreCompact") return SAFE_DEFAULT
    const fs = yield* FileSystem
    const state = yield* SessionState
    const project = yield* Project

    const root = yield* project.root()
    const record = yield* state
      .get(payload.session_id)
      .pipe(Effect.catchAll(() => Effect.succeed(EMPTY_SESSION_STATE)))

    const goal = record.next_required_action ?? "(no explicit goal recorded)"
    const filesChanged = record.files_changed
    const filesRead = record.files_read
    const commands = record.commands_run
    const failures = record.commands_failed
    const tests = record.tests_run
    const sources = record.source_urls

    const ts = Date.now()
    const tsIso = new Date(ts).toISOString()
    const safeId = sanitize(payload.session_id)
    const safeTs = sanitize(tsIso)
    const snapshotPath = path.join(
      root,
      ".claude-hooks",
      "state",
      "compact-snapshots",
      `${safeId}-${safeTs}.md`,
    )

    const fmtList = (xs: ReadonlyArray<string>): string =>
      xs.length === 0
        ? "  (none)"
        : xs.map((x) => `  - ${x}`).join("\n")

    const md = [
      "# Pre-compact preservation snapshot",
      "",
      `- session_id: ${payload.session_id}`,
      `- timestamp: ${tsIso}`,
      `- trigger: ${payload.trigger ?? "unknown"}`,
      "",
      "## Goal / next required action",
      goal,
      "",
      "## Verification status",
      record.verification_status,
      "",
      "## Files changed",
      fmtList(filesChanged),
      "",
      "## Files read",
      fmtList(filesRead),
      "",
      "## Commands run",
      fmtList(commands),
      "",
      "## Failures",
      fmtList(failures),
      "",
      "## Tests run",
      fmtList(tests),
      "",
      "## Source URLs",
      fmtList(sources),
      "",
      "## Custom instructions",
      payload.custom_instructions ?? "(none)",
      "",
    ].join("\n")

    yield* fs
      .writeFile(snapshotPath, md)
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)))

    const head = (xs: ReadonlyArray<string>): string =>
      xs.length === 0
        ? "(none)"
        : xs.length <= MAX_LIST
          ? xs.join(", ")
          : `${xs.slice(0, MAX_LIST).join(", ")} (+${xs.length - MAX_LIST} more)`

    const lines = [
      "Preservation context (pre-compact):",
      `- goal/next: ${goal}`,
      `- files_changed: ${head(filesChanged)}`,
      `- commands_run: ${head(commands)}`,
      `- failures: ${head(failures)}`,
      `- verification: ${record.verification_status}`,
      `- snapshot: ${snapshotPath}`,
    ]
    const additionalContext = truncate(lines.join("\n"), MAX_INJECT)

    const out: HookDecision = {
      hookSpecificOutput: {
        hookEventName: "PreCompact",
        additionalContext,
      },
    }
    return out
  })
