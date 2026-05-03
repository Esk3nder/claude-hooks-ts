import { Effect } from "effect"
import * as path from "node:path"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { FileSystem } from "../services/filesystem.ts"
import { Project } from "../services/project.ts"

interface InstructionsLoadedLedgerEntry {
  readonly session_id: string
  readonly file_path: string
  readonly memory_type: string
  readonly load_reason: string
  readonly ts: string
}

/**
 * InstructionsLoaded — appends a ledger entry capturing which CLAUDE.md /
 * memory file was loaded and why. SAFE_DEFAULT.
 */
export const handleInstructionsLoaded = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, FileSystem | Project> =>
  Effect.gen(function* () {
    if (payload._tag !== "InstructionsLoaded") return SAFE_DEFAULT
    const fs = yield* FileSystem
    const project = yield* Project
    const root = yield* project.root()
    const ledgerPath = path.join(
      root,
      ".claude-hooks",
      "state",
      "instructions-loaded.jsonl",
    )
    const entry: InstructionsLoadedLedgerEntry = {
      session_id: payload.session_id,
      file_path: payload.file_path,
      memory_type: payload.memory_type,
      load_reason: payload.load_reason,
      ts: new Date().toISOString(),
    }
    yield* Effect.gen(function* () {
      const existsE = yield* Effect.either(fs.exists(ledgerPath))
      const prior =
        existsE._tag === "Right" && existsE.right
          ? yield* fs
              .readFile(ledgerPath)
              .pipe(Effect.catchAll(() => Effect.succeed("")))
          : ""
      const next =
        (prior.length === 0 || prior.endsWith("\n") ? prior : prior + "\n") +
        JSON.stringify(entry) +
        "\n"
      yield* fs.writeFile(ledgerPath, next)
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
    return SAFE_DEFAULT
  })
