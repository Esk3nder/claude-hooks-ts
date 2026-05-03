import { Effect } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { Git } from "../services/git.ts"
import { Project } from "../services/project.ts"
import { Shell } from "../services/shell.ts"
import { makeShellCommand } from "../schema/branded.ts"

const MAX_DIRTY_FILES = 20
const MAX_BRIEF_BYTES = 2048

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

export const handleSessionStart = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, Git | Project | Shell> =>
  Effect.gen(function* () {
    if (payload._tag !== "SessionStart") return SAFE_DEFAULT
    const git = yield* Git
    const project = yield* Project
    const cwd = payload.cwd
    const branch = yield* git
      .currentBranch(cwd)
      .pipe(Effect.catchAll(() => Effect.succeed("unknown")))
    const dirty = yield* dirtyFiles(cwd)
    const dirtyCount = dirty.length
    const dirtyShown = dirty.slice(0, MAX_DIRTY_FILES)
    const moreDirty = dirtyCount > MAX_DIRTY_FILES ? dirtyCount - MAX_DIRTY_FILES : 0
    const typecheck = yield* project.typecheckCommand()
    const lint = yield* project.lintCommand()
    const test = yield* project.testCommand("targeted")

    const lines: string[] = []
    lines.push("# Session brief")
    lines.push("")
    lines.push(`- Branch: \`${branch}\``)
    lines.push(`- Dirty files: ${dirtyCount}`)
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
