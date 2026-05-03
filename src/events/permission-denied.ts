import { Effect } from "effect"
import * as path from "node:path"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { FileSystem } from "../services/filesystem.ts"
import { Project } from "../services/project.ts"

interface PermissionDeniedLedgerEntry {
  readonly session_id: string
  readonly tool_name: string
  readonly tool_input: unknown
  readonly denial_reason: string
  readonly permission_mode: string | null
  readonly ts: string
}

/**
 * PermissionDenied — appends to <cwd>/.claude-hooks/state/permission-denials.jsonl.
 * Best-effort, returns SAFE_DEFAULT.
 */
export const handlePermissionDenied = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, FileSystem | Project> =>
  Effect.gen(function* () {
    if (payload._tag !== "PermissionDenied") return SAFE_DEFAULT
    const fs = yield* FileSystem
    const project = yield* Project
    const root = yield* project.root()
    const ledgerPath = path.join(
      root,
      ".claude-hooks",
      "state",
      "permission-denials.jsonl",
    )
    const entry: PermissionDeniedLedgerEntry = {
      session_id: payload.session_id,
      tool_name: payload.tool_name,
      tool_input: payload.tool_input,
      denial_reason: payload.denial_reason,
      permission_mode: payload.permission_mode ?? null,
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
