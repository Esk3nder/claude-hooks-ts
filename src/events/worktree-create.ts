import { Effect, Either } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { Shell } from "../services/shell.ts"
import { makeShellCommand } from "../schema/branded.ts"

/**
 * Best-effort: copy YAML config files from <sourceCwd>/.claude-hooks/ into
 * <target>/.claude-hooks/, skipping the `state/` directory (per-worktree),
 * then ensure <target>/.claude-hooks/state/ exists. Failures are logged to
 * stderr but never thrown.
 */
const mirrorClaudeHooksConfig = (sourceCwd: string, target: string): void => {
  const srcDir = path.join(sourceCwd, ".claude-hooks")
  const dstDir = path.join(target, ".claude-hooks")
  const stateDir = path.join(dstDir, "state")
  try {
    let srcExists = false
    try {
      srcExists = fs.statSync(srcDir).isDirectory()
    } catch {
      srcExists = false
    }
    if (srcExists) {
      try {
        fs.mkdirSync(dstDir, { recursive: true })
      } catch (e) {
        process.stderr.write(`worktree-create: mkdir ${dstDir}: ${String(e)}\n`)
      }
      let entries: fs.Dirent[] = []
      try {
        entries = fs.readdirSync(srcDir, { withFileTypes: true })
      } catch (e) {
        process.stderr.write(
          `worktree-create: readdir ${srcDir}: ${String(e)}\n`,
        )
      }
      for (const ent of entries) {
        if (ent.name === "state") continue
        if (!ent.isFile()) continue
        if (!/\.(ya?ml)$/i.test(ent.name)) continue
        const from = path.join(srcDir, ent.name)
        const to = path.join(dstDir, ent.name)
        try {
          fs.copyFileSync(from, to)
        } catch (e) {
          process.stderr.write(
            `worktree-create: copy ${from} -> ${to}: ${String(e)}\n`,
          )
        }
      }
    }
    try {
      fs.mkdirSync(stateDir, { recursive: true })
    } catch (e) {
      process.stderr.write(`worktree-create: mkdir ${stateDir}: ${String(e)}\n`)
    }
  } catch (e) {
    process.stderr.write(`worktree-create: mirror error: ${String(e)}\n`)
  }
}

/**
 * WorktreeCreate — BLOCKING. Computes the worktree path under base_path,
 * runs `git worktree add <path>`, and on success mirrors `.claude-hooks`
 * YAML config from the source repo into the new worktree (best-effort),
 * then returns the path so the dispatcher can write it to stdout.
 */
export const handleWorktreeCreate = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, Shell> =>
  Effect.gen(function* () {
    if (payload._tag !== "WorktreeCreate") return SAFE_DEFAULT
    const shell = yield* Shell
    const target = path.join(payload.base_path, payload.worktree_name)
    const cmdE = makeShellCommand("git", ["worktree", "add", target])
    if (Either.isLeft(cmdE)) return SAFE_DEFAULT
    const result = yield* shell
      .run(cmdE.right)
      .pipe(
        Effect.catchAll(() =>
          Effect.succeed({ stdout: "", stderr: "shell-error", exitCode: 1 }),
        ),
      )
    if (result.exitCode !== 0) return SAFE_DEFAULT
    const sourceCwd = payload.cwd ?? process.cwd()
    yield* Effect.sync(() => mirrorClaudeHooksConfig(sourceCwd, target))
    return { worktreePath: target }
  })
