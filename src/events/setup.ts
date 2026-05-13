import { Effect } from "effect"
import * as path from "node:path"
import * as fsSync from "node:fs"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { eventStream, SetupRecordSchema } from "../schema/events.ts"
import { EventStore, summarizeEventStoreError } from "../services/event-store.ts"
import { Project } from "../services/project.ts"
import { Approvals } from "../services/approvals.ts"

interface SetupLedgerEntry {
  readonly session_id: string
  readonly trigger: string
  readonly ts: string
}

const ROTATE_THRESHOLD_BYTES = 10 * 1024 * 1024 // 10 MB
const APPROVAL_COUNT_MAX_BYTES = 1024 * 1024

/**
 * Count a bounded suffix of newline-terminated JSON records in the approvals
 * ledger. Used only to estimate "<N> pruned" since `Approvals.gc` returns
 * void. Best-effort: any read failure yields 0.
 */
const countApprovalLines = (cwd: string): number => {
  const file = path.join(cwd, ".claude-hooks", "state", "approvals.jsonl")
  try {
    if (!fsSync.existsSync(file)) return 0
    const stat = fsSync.statSync(file)
    if (!stat.isFile() || stat.size <= 0) return 0
    const length = Math.min(stat.size, APPROVAL_COUNT_MAX_BYTES)
    const start = Math.max(0, stat.size - length)
    const fd = fsSync.openSync(file, "r")
    let raw = ""
    try {
      const buffer = Buffer.alloc(length)
      const bytesRead = fsSync.readSync(fd, buffer, 0, length, start)
      raw = buffer.subarray(0, bytesRead).toString("utf8")
      if (start > 0) {
        const previous = Buffer.alloc(1)
        const previousBytes = fsSync.readSync(fd, previous, 0, 1, start - 1)
        const startsOnLineBoundary = previousBytes === 1 && (previous[0] === 0x0a || previous[0] === 0x0d)
        if (!startsOnLineBoundary) {
          const firstLineEnd = raw.indexOf("\n")
          raw = firstLineEnd >= 0 ? raw.slice(firstLineEnd + 1) : ""
        }
      }
    } finally {
      fsSync.closeSync(fd)
    }
    let n = 0
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim().length > 0) n++
    }
    return n
  } catch {
    return 0
  }
}

/**
 * Rotate any `.jsonl` files in `<cwd>/.claude-hooks/state/` that exceed
 * `ROTATE_THRESHOLD_BYTES` to `<file>.<ISO>.archive`. Returns the number
 * rotated. Best-effort — silent on individual failures.
 */
const rotateLargeLedgers = (cwd: string): number => {
  const dir = path.join(cwd, ".claude-hooks", "state")
  if (!fsSync.existsSync(dir)) return 0
  let rotated = 0
  let entries: string[] = []
  try {
    entries = fsSync.readdirSync(dir)
  } catch {
    return 0
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue
    const file = path.join(dir, name)
    try {
      const st = fsSync.statSync(file)
      if (!st.isFile() || st.size <= ROTATE_THRESHOLD_BYTES) continue
      fsSync.renameSync(file, `${file}.${stamp}.archive`)
      rotated++
    } catch {
      // skip this file
    }
  }
  return rotated
}

/**
 * Setup — supports two triggers:
 * - `init`: ensures `.claude-hooks/` skeleton exists (state dir + a
 * one-line README pointing at this package HOOK-EVENTS reference).
 * - `maintenance`: forces an `Approvals.gc` pass and rotates oversized
 * ledger JSONL files.
 * In both cases a ledger entry is appended (best-effort).
 */
export const handleSetup = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, EventStore | Project | Approvals> =>
  Effect.gen(function* () {
    if (payload._tag !== "Setup") return SAFE_DEFAULT
    const eventStore = yield* EventStore
    const project = yield* Project
    const approvals = yield* Approvals
    const root = yield* project.root()
    const trigger = payload.trigger ?? "init"

    const ledgerPath = path.join(root, ".claude-hooks", "state", "setup.jsonl")
    const entry: SetupLedgerEntry = {
      session_id: payload.session_id,
      trigger,
      ts: new Date().toISOString(),
    }
    yield* eventStore.append(eventStream("setup", ledgerPath, SetupRecordSchema, { maxRecords: 1_000 }), entry).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          process.stderr.write(
            `setup: ledger write failed: ${summarizeEventStoreError(err)}\n`,
          )
        }),
      ),
    )

    if (trigger === "maintenance") {
      const before = countApprovalLines(root)
      yield* approvals
        .gc(root, Date.now())
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      const after = countApprovalLines(root)
      const pruned = Math.max(0, before - after)
      const rotated = rotateLargeLedgers(root)
      return {
        hookSpecificOutput: {
          hookEventName: "Setup",
          additionalContext: `Maintenance pass: pruned ${pruned} approvals, rotated ${rotated} ledger files.`,
        },
      }
    }

    if (trigger === "init") {
      const hookDir = path.join(root, ".claude-hooks")
      const stateDir = path.join(hookDir, "state")
      const readme = path.join(hookDir, "README.md")
      let created = false
      try {
        if (!fsSync.existsSync(hookDir)) {
          fsSync.mkdirSync(stateDir, { recursive: true })
          fsSync.writeFileSync(
            readme,
            "policies: see https://github.com/Esk3nder/claude-hooks-ts/blob/main/docs/HOOK-EVENTS.md\n",
            "utf8",
          )
          created = true
        } else {
          if (!fsSync.existsSync(stateDir)) {
            fsSync.mkdirSync(stateDir, { recursive: true })
            created = true
          }
          if (!fsSync.existsSync(readme)) {
            fsSync.writeFileSync(
              readme,
              "policies: see https://github.com/Esk3nder/claude-hooks-ts/blob/main/docs/HOOK-EVENTS.md\n",
              "utf8",
            )
            created = true
          }
        }
      } catch {
        // best-effort
      }
      if (created) {
        return {
          hookSpecificOutput: {
            hookEventName: "Setup",
            additionalContext: `Initialized .claude-hooks/ at ${root}`,
          },
        }
      }
    }

    return SAFE_DEFAULT
  })
