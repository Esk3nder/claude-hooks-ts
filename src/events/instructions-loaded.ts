import { Effect } from "effect"
import * as path from "node:path"
import * as fsSync from "node:fs"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { NO_DECISION } from "../schema/decisions.ts"
import { eventStream, InstructionsLoadedRecordSchema } from "../schema/events.ts"
import { EventStore, summarizeEventStoreError } from "../services/event-store.ts"
import { Project } from "../services/project.ts"
import { logWarning } from "../services/diagnostics.ts"

interface InstructionsLoadedLedgerEntry {
  readonly session_id: string
  readonly file_path: string
  readonly memory_type: string
  readonly load_reason: string
  readonly ts: string
}

const STALE_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const MS_PER_DAY = 24 * 60 * 60 * 1000

const isThirdPartyHookFile = (filePath: string): boolean => {
  const base = path.basename(filePath)
  return /^bifrost-.*\.md$/.test(base) || /\.cursorrules$/.test(base)
}

/**
 * Best-effort mtime read in epoch-ms. Null on any failure (missing file,
 * permission, etc.) — caller treats null as "no opinion".
 */
const safeMtimeMs = (filePath: string): number | null => {
  try {
    const st = fsSync.statSync(filePath)
    return st.mtimeMs
  } catch {
    return null
  }
}

const formatDate = (ms: number): string => {
  const d = new Date(ms)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0")
  const dd = String(d.getUTCDate()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd}`
}

/**
 * InstructionsLoaded — appends a ledger entry for observability, then:
 *   - Warns when a Project memory file loaded at session start is >30 days
 *     old (likely-stale CLAUDE.md).
 *   - Flags third-party hook tooling (`bifrost-*.md`, `.cursorrules`) so the
 *     user knows claude-hooks-ts may be composing with another layer.
 */
export const handleInstructionsLoaded = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, EventStore | Project> =>
  Effect.gen(function* () {
    if (payload._tag !== "InstructionsLoaded") return NO_DECISION
    const eventStore = yield* EventStore
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
    yield* eventStore
      .append(eventStream("instructions-loaded", ledgerPath, InstructionsLoadedRecordSchema, { maxRecords: 1_000 }), entry)
      .pipe(
        Effect.catchAll((err) =>
          logWarning(
            `instructions-loaded: ledger write failed: ${summarizeEventStoreError(err)}`,
          ),
        ),
      )

    if (isThirdPartyHookFile(payload.file_path)) {
      return {
        hookSpecificOutput: {
          hookEventName: "InstructionsLoaded",
          additionalContext: `Third-party hook tooling detected (${path.basename(
            payload.file_path,
          )}). claude-hooks-ts may compose with it.`,
        },
      }
    }

    if (
      payload.memory_type === "Project" &&
      payload.load_reason === "session_start"
    ) {
      const mtime = safeMtimeMs(payload.file_path)
      if (mtime !== null) {
        const ageMs = Date.now() - mtime
        if (ageMs > STALE_AGE_MS) {
          const ageDays = Math.floor(ageMs / MS_PER_DAY)
          return {
            hookSpecificOutput: {
              hookEventName: "InstructionsLoaded",
              additionalContext: `CLAUDE.md is ${ageDays} days old (last modified ${formatDate(
                mtime,
              )}). Consider refreshing project context.`,
            },
          }
        }
      }
    }

    return NO_DECISION
  })
