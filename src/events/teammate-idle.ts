import { Effect } from "effect"
import * as path from "node:path"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { FileSystem } from "../services/filesystem.ts"
import { Project } from "../services/project.ts"
import { SessionState } from "../services/session-state.ts"

interface TeammateIdleLedgerEntry {
  readonly session_id: string
  readonly teammate_name: string
  readonly teammate_type: string
  readonly ts: string
}

/**
 * TeammateIdle — block going idle if the session has unverified pending work
 * (`files_changed.length > 0 && verification_status !== "passed"`). Always
 * appends a best-effort ledger entry; ledger failures are swallowed so they
 * never affect the decision.
 */
export const handleTeammateIdle = (
  payload: HookPayload,
): Effect.Effect<
  HookDecision,
  never,
  FileSystem | Project | SessionState
> =>
  Effect.gen(function* () {
    if (payload._tag !== "TeammateIdle") return SAFE_DEFAULT
    const fs = yield* FileSystem
    const project = yield* Project
    const state = yield* SessionState
    const root = yield* project.root()

    const ledgerPath = path.join(
      root,
      ".claude-hooks",
      "state",
      "teammate-idle.jsonl",
    )
    const entry: TeammateIdleLedgerEntry = {
      session_id: payload.session_id,
      teammate_name: payload.teammate_name,
      teammate_type: payload.teammate_type,
      ts: new Date().toISOString(),
    }
    yield* fs
      .withLock(
        ledgerPath,
        Effect.gen(function* () {
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
        }),
      )
      .pipe(
        Effect.tapError((cause) =>
          Effect.sync(() => {
            process.stderr.write(
              `[TeammateIdle] ledger append failed: ${String(cause).slice(0, 160)}\n`,
            )
          }),
        ),
        Effect.catchAll(() => Effect.succeed(undefined)),
      )

    const stateE = yield* Effect.either(
      state.get(payload.session_id).pipe(
        Effect.tapError((cause) =>
          Effect.sync(() => {
            process.stderr.write(
              `[TeammateIdle] session-state op=get failed: sid=${payload.session_id} cause=${String(cause).slice(0, 160)}\n`,
            )
          }),
        ),
      ),
    )
    if (stateE._tag === "Right") {
      const rec = stateE.right
      if (
        rec.files_changed.length > 0 &&
        rec.verification_status !== "passed"
      ) {
        return {
          decision: "block",
          reason: `Files changed (${rec.files_changed.length}) without verification — finish current work before going idle.`,
        }
      }
    }
    return SAFE_DEFAULT
  })
