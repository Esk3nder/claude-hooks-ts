import { Effect } from "effect"
import * as path from "node:path"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { FileSystem } from "../services/filesystem.ts"
import { Project } from "../services/project.ts"

const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9._-]/g, "_")

interface PostCompactLedgerEntry {
  readonly session_id: string
  readonly trigger: string
  readonly compacted_at: string
  readonly snapshot_path: string | null
}

/**
 * PostCompact handler — appends an audit entry to a JSONL ledger so we can
 * reconstruct what happened around each compaction event. Best-effort:
 * always returns SAFE_DEFAULT and never propagates write failures.
 */
export const handlePostCompact = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, FileSystem | Project> =>
  Effect.gen(function* () {
    if (payload._tag !== "PostCompact") return SAFE_DEFAULT
    const fs = yield* FileSystem
    const project = yield* Project

    const root = yield* project.root()
    const ts = Date.now()
    const tsIso = new Date(ts).toISOString()
    const safeId = sanitize(payload.session_id)
    const safeTs = sanitize(tsIso)

    // Mirrors precompact-snapshot's naming so audits can correlate.
    const snapshotPath = path.join(
      root,
      ".claude-hooks",
      "state",
      "compact-snapshots",
      `${safeId}-${safeTs}.md`,
    )

    const entry: PostCompactLedgerEntry = {
      session_id: payload.session_id,
      trigger: payload.trigger ?? "unknown",
      compacted_at: tsIso,
      snapshot_path: snapshotPath,
    }

    const ledgerPath = path.join(
      root,
      ".claude-hooks",
      "state",
      "postcompact-ledger.jsonl",
    )

    // Read existing contents (if any) and append a new line. Best-effort —
    // any failure leaves the ledger untouched and we still return SAFE_DEFAULT.
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
