import { Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"
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
 * Walk parents of `worktreePath` looking for the main repo: the directory
 * whose `.git` entry is itself a directory (worktrees have a `.git` *file*
 * pointing back at the main repo).
 */
const findMainRepo = (worktreePath: string): string | null => {
  let dir = path.dirname(worktreePath)
  for (let i = 0; i < 30; i++) {
    const dotGit = path.join(dir, ".git")
    try {
      const st = fs.statSync(dotGit)
      if (st.isDirectory()) return dir
    } catch {
      // not present; keep walking
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Best-effort: archive every `*.jsonl` under `<worktreePath>/.claude-hooks/state/`
 * into `<mainRepo>/.claude-hooks/state/archived/<basename>-<ISO>/`. Then run
 * `git worktree remove --force` (best-effort, non-fatal).
 */
const archiveAndRemove = (worktreePath: string, mainRepo: string): void => {
  const stateDir = path.join(worktreePath, ".claude-hooks", "state")
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(stateDir, { withFileTypes: true })
  } catch {
    entries = []
  }
  const jsonl = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
  if (jsonl.length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const base = path.basename(worktreePath)
    const archiveDir = path.join(
      mainRepo,
      ".claude-hooks",
      "state",
      "archived",
      `${base}-${stamp}`,
    )
    try {
      fs.mkdirSync(archiveDir, { recursive: true })
      for (const ent of jsonl) {
        const from = path.join(stateDir, ent.name)
        const to = path.join(archiveDir, ent.name)
        try {
          fs.copyFileSync(from, to)
        } catch (e) {
          process.stderr.write(
            `worktree-remove: archive ${from} -> ${to}: ${String(e)}\n`,
          )
        }
      }
    } catch (e) {
      process.stderr.write(
        `worktree-remove: mkdir ${archiveDir}: ${String(e)}\n`,
      )
    }
  }
  // Best-effort `git worktree remove --force`.
  try {
    Bun.spawnSync(["git", "worktree", "remove", "--force", worktreePath], {
      cwd: mainRepo,
      stdout: "ignore",
      stderr: "ignore",
    })
  } catch (e) {
    process.stderr.write(`worktree-remove: git remove: ${String(e)}\n`)
  }
}

/**
 * WorktreeRemove — archives the worktree's JSONL ledgers into the main repo's
 * `.claude-hooks/state/archived/` before running `git worktree remove --force`.
 * Then appends a small ledger entry to the main repo. SAFE_DEFAULT.
 */
export const handleWorktreeRemove = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, FileSystem | Project> =>
  Effect.gen(function* () {
    if (payload._tag !== "WorktreeRemove") return SAFE_DEFAULT
    const fs2 = yield* FileSystem
    const project = yield* Project
    const root = yield* project.root()

    // Archive + git worktree remove (best-effort, sync, never throws).
    yield* Effect.sync(() => {
      const mainRepo =
        findMainRepo(payload.worktree_path) ?? payload.cwd ?? root
      archiveAndRemove(payload.worktree_path, mainRepo)
    })

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
      const existsE = yield* Effect.either(fs2.exists(ledgerPath))
      const prior =
        existsE._tag === "Right" && existsE.right
          ? yield* fs2
              .readFile(ledgerPath)
              .pipe(Effect.catchAll(() => Effect.succeed("")))
          : ""
      const next =
        (prior.length === 0 || prior.endsWith("\n") ? prior : prior + "\n") +
        JSON.stringify(entry) +
        "\n"
      yield* fs2.writeFile(ledgerPath, next)
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
    return SAFE_DEFAULT
  })
