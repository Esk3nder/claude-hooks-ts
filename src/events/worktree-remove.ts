import { Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { eventStream, WorktreeRemoveRecordSchema } from "../schema/events.ts"
import { CommandRunner } from "../services/command-runner.ts"
import { EventStore, redactForPersistence, summarizeEventStoreError } from "../services/event-store.ts"
import { Project } from "../services/project.ts"

interface WorktreeRemoveLedgerEntry {
  readonly session_id: string
  readonly worktree_path: string
  readonly ts: string
}

const MAX_ARCHIVE_JSONL_FILES = 200
const MAX_ARCHIVE_FILE_BYTES = 1024 * 1024
const MAX_ARCHIVE_LINES = 1_000
const MAX_ARCHIVE_LINE_BYTES = 32 * 1024

interface JsonlFile {
  readonly path: string
  readonly size: number
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
const collectJsonlFiles = (root: string): { files: JsonlFile[]; capped: boolean } => {
  const out: JsonlFile[] = []
  let capped = false
  const walk = (dir: string): void => {
    if (out.length >= MAX_ARCHIVE_JSONL_FILES) {
      capped = true
      return
    }
    let ents: fs.Dirent[]
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_ARCHIVE_JSONL_FILES) {
        capped = true
        return
      }
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        try {
          out.push({ path: p, size: fs.statSync(p).size })
        } catch {
          // best-effort archive; skip files that disappear mid-walk
        }
      }
    }
  }
  walk(root)
  return { files: out, capped }
}

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8")

const readBoundedTail = (
  file: JsonlFile,
): { text: string; truncatedStart: boolean; dropLeadingLine: boolean } => {
  const length = Math.min(file.size, MAX_ARCHIVE_FILE_BYTES)
  if (length <= 0) return { text: "", truncatedStart: false, dropLeadingLine: false }
  const buffer = Buffer.alloc(length)
  const start = Math.max(0, file.size - length)
  const fd = fs.openSync(file.path, "r")
  try {
    let offset = 0
    while (offset < length) {
      const read = fs.readSync(fd, buffer, offset, length - offset, start + offset)
      if (read === 0) break
      offset += read
    }
    let dropLeadingLine = start > 0
    if (start > 0) {
      const previous = Buffer.alloc(1)
      const read = fs.readSync(fd, previous, 0, 1, start - 1)
      if (read === 1 && (previous[0] === 0x0a || previous[0] === 0x0d)) {
        dropLeadingLine = false
      }
    }
    return {
      text: buffer.subarray(0, offset).toString("utf8"),
      truncatedStart: start > 0,
      dropLeadingLine,
    }
  } finally {
    fs.closeSync(fd)
  }
}

const archiveNotice = (reason: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ archive_notice: { reason, redacted: true, ...extra } })

const sanitizeArchiveLine = (line: string): string => {
  const lineBytes = byteLength(line)
  if (lineBytes > MAX_ARCHIVE_LINE_BYTES) {
    return archiveNotice("line_too_large", { bytes: lineBytes })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return archiveNotice("invalid_jsonl", { bytes: lineBytes })
  }
  const serialized = JSON.stringify(redactForPersistence(parsed))
  return byteLength(serialized) <= MAX_ARCHIVE_LINE_BYTES
    ? serialized
    : archiveNotice("redacted_line_too_large", { bytes: byteLength(serialized) })
}

const writeSanitizedJsonlArchive = (from: JsonlFile, to: string): void => {
  const bounded = readBoundedTail(from)
  let lines = bounded.text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (bounded.dropLeadingLine && lines.length > 0) lines = lines.slice(1)
  const omittedLines = Math.max(0, lines.length - MAX_ARCHIVE_LINES)
  if (omittedLines > 0) lines = lines.slice(-MAX_ARCHIVE_LINES)
  const output: string[] = []
  if (bounded.truncatedStart) {
    output.push(archiveNotice("file_tail_truncated", { max_bytes: MAX_ARCHIVE_FILE_BYTES }))
  }
  if (omittedLines > 0) {
    output.push(archiveNotice("line_count_truncated", { omitted: omittedLines }))
  }
  for (const line of lines) output.push(sanitizeArchiveLine(line))
  fs.writeFileSync(to, output.length === 0 ? "" : `${output.join("\n")}\n`, "utf8")
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
  const { files: found, capped } = collectJsonlFiles(stateDir)
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
      if (capped) {
        process.stderr.write(
          `worktree-remove: archive capped at ${MAX_ARCHIVE_JSONL_FILES} jsonl files under ${stateDir}\n`,
        )
      }
      for (const from of found) {
        const rel = path.relative(stateDir, from.path)
        const to = path.join(archiveDir, rel)
        try {
          fs.mkdirSync(path.dirname(to), { recursive: true })
          writeSanitizedJsonlArchive(from, to)
        } catch (e) {
          process.stderr.write(
            `worktree-remove: archive ${from.path} -> ${to}: ${String(e)}\n`,
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
            `worktree-remove: ledger append failed: ${summarizeEventStoreError(err)}\n`,
          )
        }),
      ),
    )
    return SAFE_DEFAULT
  })
