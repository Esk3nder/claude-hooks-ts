import { Effect } from "effect"
import * as path from "node:path"
import * as fsSync from "node:fs"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { FileSystem } from "../services/filesystem.ts"
import { Project } from "../services/project.ts"
import { Approvals } from "../services/approvals.ts"

interface SetupLedgerEntry {
  readonly session_id: string
  readonly trigger: string
  readonly ts: string
}

const ROTATE_THRESHOLD_BYTES = 10 * 1024 * 1024 // 10 MB

/**
 * Count newline-terminated JSON records in the approvals ledger. Used to
 * estimate "<N> pruned" since `Approvals.gc` returns void. Best-effort: any
 * read failure yields 0.
 */
const countApprovalLines = (cwd: string): number => {
  const file = path.join(cwd, ".claude-hooks", "state", "approvals.jsonl")
  try {
    if (!fsSync.existsSync(file)) return 0
    const raw = fsSync.readFileSync(file, "utf8")
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
): Effect.Effect<HookDecision, never, FileSystem | Project | Approvals> =>
  Effect.gen(function* () {
    if (payload._tag !== "Setup") return SAFE_DEFAULT
    const fs = yield* FileSystem
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
    const append = Effect.gen(function* () {
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
    })
    yield* fs.withLock(ledgerPath, append).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          process.stderr.write(
            `setup: ledger write failed: ${String(err).slice(0, 120)}\n`,
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
