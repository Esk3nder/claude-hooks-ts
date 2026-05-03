import { Effect, Either } from "effect"
import * as path from "node:path"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { Shell } from "../services/shell.ts"
import { makeShellCommand } from "../schema/branded.ts"

/**
 * WorktreeCreate — BLOCKING. Computes the worktree path under base_path,
 * runs `git worktree add <path>`, and on success returns the path so the
 * dispatcher can write it to stdout (raw, not JSON). On failure returns
 * SAFE_DEFAULT and the dispatcher exits non-zero via stderr signaling.
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
    return { worktreePath: target }
  })
