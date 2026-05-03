import { Effect } from "effect"
import * as path from "node:path"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { FileSystem } from "../services/filesystem.ts"
import { SessionState, EMPTY_SESSION_STATE } from "../services/session-state.ts"
import { Project } from "../services/project.ts"

const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9._-]/g, "_")

export const handleSessionEnd = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, FileSystem | SessionState | Project> =>
  Effect.gen(function* () {
    if (payload._tag !== "SessionEnd") return SAFE_DEFAULT
    const fs = yield* FileSystem
    const state = yield* SessionState
    const project = yield* Project

    const root = yield* project.root()
    const record = yield* state
      .get(payload.session_id)
      .pipe(Effect.catchAll(() => Effect.succeed(EMPTY_SESSION_STATE)))
    const ts = Date.now()
    const tsIso = new Date(ts).toISOString()
    const file = path.join(
      root,
      ".claude-hooks",
      "state",
      "sessions",
      `${sanitize(payload.session_id)}.md`,
    )

    const fmtList = (xs: ReadonlyArray<string>): string =>
      xs.length === 0 ? "  (none)" : xs.map((x) => `  - ${x}`).join("\n")

    const md = [
      "# Session summary",
      "",
      `- session_id: ${payload.session_id}`,
      `- ended_at: ${tsIso}`,
      `- reason: ${payload.reason ?? "(unspecified)"}`,
      `- verification_status: ${record.verification_status}`,
      `- next_required_action: ${record.next_required_action ?? "(none)"}`,
      "",
      "## Files changed",
      fmtList(record.files_changed),
      "",
      "## Files read",
      fmtList(record.files_read),
      "",
      "## Commands run",
      fmtList(record.commands_run),
      "",
      "## Commands failed",
      fmtList(record.commands_failed),
      "",
      "## Tests run",
      fmtList(record.tests_run),
      "",
      "## Source URLs",
      fmtList(record.source_urls),
      "",
    ].join("\n")

    yield* fs
      .writeFile(file, md)
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)))

    return SAFE_DEFAULT
  })
