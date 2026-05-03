import { Effect } from "effect"
import * as path from "node:path"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { FileSystem } from "../services/filesystem.ts"
import { Project } from "../services/project.ts"

interface ElicitationResultLedgerEntry {
  readonly session_id: string
  readonly server_name: string
  readonly tool_name: string
  readonly action: string
  readonly content: unknown
  readonly ts: string
}

/**
 * ElicitationResult — minimal ledger entry. SAFE_DEFAULT (no policy yet).
 */
export const handleElicitationResult = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, FileSystem | Project> =>
  Effect.gen(function* () {
    if (payload._tag !== "ElicitationResult") return SAFE_DEFAULT
    const fs = yield* FileSystem
    const project = yield* Project
    const root = yield* project.root()
    const ledgerPath = path.join(
      root,
      ".claude-hooks",
      "state",
      "elicitation-results.jsonl",
    )
    const entry: ElicitationResultLedgerEntry = {
      session_id: payload.session_id,
      server_name: payload.server_name,
      tool_name: payload.tool_name,
      action: payload.action,
      content: payload.content ?? null,
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
