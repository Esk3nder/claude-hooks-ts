import { Effect } from "effect"
import * as path from "node:path"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { FileSystem } from "../services/filesystem.ts"
import { Project } from "../services/project.ts"

interface WorktreeRemoveLedgerEntry {
  readonly session_id: string
  readonly worktree_path: string
  readonly ts: string
}

/**
 * WorktreeRemove — minimal ledger entry. SAFE_DEFAULT.
 */
export const handleWorktreeRemove = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, FileSystem | Project> =>
  Effect.gen(function* () {
    if (payload._tag !== "WorktreeRemove") return SAFE_DEFAULT
    const fs = yield* FileSystem
    const project = yield* Project
    const root = yield* project.root()
    const ledgerPath = path.join(
      root,
      ".claude-hooks",
      "state",
      "worktree-remove.jsonl",
    )
    const entry: WorktreeRemoveLedgerEntry = {
      session_id: payload.session_id,
      worktree_path: payload.worktree_path,
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
