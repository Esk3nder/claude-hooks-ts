import { Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { eventStream, WorktreeRemoveRecordSchema } from "../schema/events.ts"
import { CommandRunner } from "../services/command-runner.ts"
import { EventStore } from "../services/event-store.ts"
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
 * Walk a directory tree, returning every regular file ending in `.jsonl`.
 * Used to capture both top-level legacy ledgers and per-session
 * `state/<sessionId>/ledger.jsonl` files before archival.
 */
const collectJsonlFiles = (root: string): string[] => {
  const out: string[] = []
  const walk = (dir: string): void => {
    let ents: fs.Dirent[]
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of ents) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.isFile() && ent.name.endsWith(".jsonl")) out.push(p)
    }
  }
  walk(root)
  return out
}

/**
 * Best-effort: archive every `*.jsonl` under `<worktreePath>/.claude-hooks/state/`
 * (recursively, so per-session subdirs are captured) into
 * `<mainRepo>/.claude-hooks/state/archived/<basename>-<ISO>/`, preserving
 * relative paths. Then run `git worktree remove --force` (best-effort,
 * non-fatal).
 */
const archiveWorktreeLedgers = (worktreePath: string, mainRepo: string): void => {
  const stateDir = path.join(worktreePath, ".claude-hooks", "state")
  const found = collectJsonlFiles(stateDir)
  if (found.length > 0) {
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
      for (const from of found) {
        const rel = path.relative(stateDir, from)
        const to = path.join(archiveDir, rel)
        try {
          fs.mkdirSync(path.dirname(to), { recursive: true })
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
}

const worktreeRemoveStream = (root: string) =>
  eventStream(
    "worktree-remove",
    path.join(root, ".claude-hooks", "state", "worktree-remove.jsonl"),
    WorktreeRemoveRecordSchema,
    { maxRecords: 1_000 },
  )

/**
 * WorktreeRemove — archives the worktree's JSONL ledgers into the main repo's
 * `.claude-hooks/state/archived/` before running `git worktree remove --force`.
 * Then appends a small ledger entry to the main repo. SAFE_DEFAULT.
 */
export const handleWorktreeRemove = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, CommandRunner | EventStore | Project> =>
  Effect.gen(function* () {
    if (payload._tag !== "WorktreeRemove") return SAFE_DEFAULT
    const runner = yield* CommandRunner
    const eventStore = yield* EventStore
    const project = yield* Project
    const root = yield* project.root()

    const mainRepo = findMainRepo(payload.worktree_path) ?? payload.cwd ?? root
    yield* Effect.sync(() => archiveWorktreeLedgers(payload.worktree_path, mainRepo))
    yield* runner
      .run("git", ["worktree", "remove", "--force", payload.worktree_path], {
        cwd: mainRepo,
        timeoutMs: 10_000,
        stdoutMaxBytes: 1_000,
        stderrMaxBytes: 2_000,
      })
      .pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0 && !result.timedOut
            ? Effect.void
            : Effect.sync(() => {
                const detail = (result.stderr || result.stdout || `exit ${result.exitCode}`).slice(0, 200)
                process.stderr.write(`worktree-remove: git remove failed: ${detail}\n`)
              }),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            process.stderr.write(`worktree-remove: git remove: ${String(err).slice(0, 200)}\n`)
          }),
        ),
      )

    const entry: WorktreeRemoveLedgerEntry = {
      session_id: payload.session_id,
      worktree_path: payload.worktree_path,
      ts: new Date().toISOString(),
    }
    yield* eventStore.append(worktreeRemoveStream(root), entry).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          process.stderr.write(
            `worktree-remove: ledger append failed: ${String(err).slice(0, 120)}\n`,
          )
        }),
      ),
    )
    return SAFE_DEFAULT
  })
