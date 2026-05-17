import { Effect } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { NO_DECISION } from "../schema/decisions.ts"
import { Git } from "../services/git.ts"
import { Project } from "../services/project.ts"
import { Shell } from "../services/shell.ts"
import { makeShellCommand } from "../schema/branded.ts"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"

const MAX_DIRTY_FILES = 20
const MAX_BRIEF_BYTES = 2048
const STALE_WORK_DIR_DAYS = 14

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, Math.max(0, max - 3)) + "..."

const dirtyFiles = (cwd?: string): Effect.Effect<ReadonlyArray<string>, never, Shell> =>
  Effect.gen(function* () {
    const shell = yield* Shell
    const cmdE = makeShellCommand("git", ["status", "--porcelain"])
    if (cmdE._tag === "Left") return [] as ReadonlyArray<string>
    const result = yield* shell
      .run(cmdE.right, cwd !== undefined ? { cwd, timeoutMs: 2000 } : { timeoutMs: 2000 })
      .pipe(Effect.catchAll(() => Effect.succeed({ stdout: "", stderr: "", exitCode: -1 })))
    if (result.exitCode !== 0) return [] as ReadonlyArray<string>
    return result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
  })

interface WorkDirArchiveSummary {
  readonly archived: number
  readonly stale: number
}

const hasCompletePhase = (dir: string): boolean => {
  for (const name of ["ISA.md", "PRD.md"]) {
    const p = join(dir, name)
    if (!existsSync(p)) continue
    try {
      return /^phase:\s*complete\s*$/im.test(readFileSync(p, "utf8"))
    } catch {
      return false
    }
  }
  return false
}

const archiveTarget = (cwd: string, slug: string): string => {
  const day = new Date().toISOString().slice(0, 10)
  let target = join(cwd, ".claude-hooks", "archive", day, slug)
  let i = 2
  while (existsSync(target)) {
    target = join(cwd, ".claude-hooks", "archive", day, `${slug}-${i}`)
    i += 1
  }
  return target
}

const archiveWorkDirs = (cwd?: string): WorkDirArchiveSummary => {
  if (cwd === undefined) return { archived: 0, stale: 0 }
  const workRoot = join(cwd, ".claude-hooks", "work")
  if (!existsSync(workRoot)) return { archived: 0, stale: 0 }
  let archived = 0
  let stale = 0
  const cutoff = Date.now() - STALE_WORK_DIR_DAYS * 24 * 60 * 60 * 1000
  for (const name of readdirSync(workRoot)) {
    const from = join(workRoot, name)
    let stat
    try {
      stat = statSync(from)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    const complete = hasCompletePhase(from)
    const old = stat.mtimeMs < cutoff
    if (!complete && !old) continue
    try {
      const to = archiveTarget(cwd, basename(from))
      mkdirSync(dirname(to), { recursive: true })
      renameSync(from, to)
      archived += 1
      if (old && !complete) stale += 1
    } catch {
      // Best effort only; SessionStart should never block on housekeeping.
    }
  }
  return { archived, stale }
}

const summarizeDirty = (dirty: ReadonlyArray<string>): ReadonlyArray<string> => {
  const workDirs = new Set<string>()
  const kept: string[] = []
  for (const d of dirty) {
    const match = d.match(
      /^(?:[? MADRCU]{1,2}\s+)?(\.claude-hooks\/work\/[^/]+)\//,
    )
    if (match?.[1]) {
      workDirs.add(match[1])
      continue
    }
    kept.push(d)
  }
  if (workDirs.size === 0) return dirty
  return [
    `.claude-hooks/work/: ${workDirs.size} work dir${workDirs.size === 1 ? "" : "s"} summarized (see git status for names)`,
    ...kept,
  ]
}

export const handleSessionStart = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, Git | Project | Shell> =>
  Effect.gen(function* () {
    if (payload._tag !== "SessionStart") return NO_DECISION
    const git = yield* Git
    const project = yield* Project
    const cwd = payload.cwd
    const archiveSummary = archiveWorkDirs(cwd)
    const branch = yield* git
      .currentBranch(cwd)
      .pipe(Effect.catchAll(() => Effect.succeed("unknown")))
    const dirty = yield* dirtyFiles(cwd)
    const summarizedDirty = summarizeDirty(dirty)
    const collapsedWorkDirs =
      dirty.length -
      summarizedDirty.length +
      (summarizedDirty.length === dirty.length ? 0 : 1)
    const dirtyCount = summarizedDirty.length
    const dirtyShown = summarizedDirty.slice(0, MAX_DIRTY_FILES)
    const moreDirty = summarizedDirty.length > MAX_DIRTY_FILES ? summarizedDirty.length - MAX_DIRTY_FILES : 0
    const typecheck = yield* project.typecheckCommand()
    const lint = yield* project.lintCommand()
    const test = yield* project.testCommand("targeted")

    const lines: string[] = []
    lines.push("# Session brief")
    lines.push("")
    lines.push(`- Branch: \`${branch}\``)
    lines.push(
      collapsedWorkDirs > 0
        ? `- Dirty files: ${dirtyCount} (+${collapsedWorkDirs} work dir entries collapsed)`
        : `- Dirty files: ${dirtyCount}`,
    )
    if (archiveSummary.archived > 0) {
      lines.push(
        `- Archived stale work dirs: ${archiveSummary.archived}` +
          (archiveSummary.stale > 0 ? ` (${archiveSummary.stale} older than ${STALE_WORK_DIR_DAYS}d)` : ""),
      )
    }
    if (dirtyShown.length > 0) {
      for (const d of dirtyShown) lines.push(`  - ${d}`)
      if (moreDirty > 0) lines.push(`  - ...and ${moreDirty} more`)
    }
    lines.push("")
    lines.push("## Verification commands")
    lines.push(`- Typecheck: ${typecheck ?? "(none detected)"}`)
    lines.push(`- Lint: ${lint ?? "(none detected)"}`)
    lines.push(`- Test: ${test ?? "(none detected)"}`)

    const brief = truncate(lines.join("\n"), MAX_BRIEF_BYTES)
    const out: HookDecision = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: brief,
      },
    }
    return out
  })
