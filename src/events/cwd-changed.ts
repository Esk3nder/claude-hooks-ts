import { Effect, Either } from "effect"
import * as path from "node:path"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { NO_DECISION } from "../schema/decisions.ts"
import { FileSystem } from "../services/filesystem.ts"
import { Shell, type ShellApi } from "../services/shell.ts"
import { SessionState } from "../services/session-state.ts"
import { makeShellCommand } from "../schema/branded.ts"

/**
 * Best-effort `git rev-parse --show-toplevel` for the given cwd. Returns the
 * trimmed path on exit-0, or null on any failure (non-zero exit, missing git,
 * shell error, branded-cmd error). The caller treats null as "unknown root".
 */
const gitToplevel = (
  shell: ShellApi,
  cwd: string,
): Effect.Effect<string | null, never> =>
  Effect.gen(function* () {
    const cmdE = makeShellCommand("git", [
      "-C",
      cwd,
      "rev-parse",
      "--show-toplevel",
    ])
    if (Either.isLeft(cmdE)) return null
    const res = yield* shell.run(cmdE.right).pipe(Effect.either)
    if (Either.isLeft(res)) return null
    if (res.right.exitCode !== 0) return null
    const out = res.right.stdout.trim()
    return out.length === 0 ? null : out
  })

/**
 * CwdChanged — detect project switches via differing git toplevels. On a
 * confirmed switch, reset the per-session record (so stale `files_changed` /
 * `verification_status` from the previous project don't bleed across) and
 * inject a one-line context advisory. When git roots match (or are both
 * unknown) but the new cwd has a project-local `.claude-hooks/`, fall back to
 * the previous behaviour of just flagging the local config.
 */
export const handleCwdChanged = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, FileSystem | Shell | SessionState> =>
  Effect.gen(function* () {
    if (payload._tag !== "CwdChanged") return NO_DECISION
    const fs = yield* FileSystem
    const shell = yield* Shell
    const state = yield* SessionState

    const localConfig = path.join(payload.new_cwd, ".claude-hooks")
    const localExistsE = yield* Effect.either(fs.exists(localConfig))
    const hasLocalConfig =
      localExistsE._tag === "Right" && localExistsE.right === true

    const prevRoot = yield* gitToplevel(shell, payload.previous_cwd)
    const newRoot = yield* gitToplevel(shell, payload.new_cwd)

    // Treat a confirmed mismatch as a project switch. If either side is null
    // (best-effort failure) we don't assume a switch — too noisy.
    const projectSwitched =
      prevRoot !== null && newRoot !== null && prevRoot !== newRoot

    if (projectSwitched) {
      // Engagement freeze: when the session is in engaged mode, the
      // frozen fields (session_root, expected_isa_path_absolute, etc.)
      // are the only way downstream gates can identify the active ISA.
      // A confirmed project switch must NOT wipe them — that defeats
      // the freeze invariant PR #38 established. Reset still fires for
      // non-engaged sessions so stale verification ledger doesn't bleed
      // across projects.
      const prior = yield* state
        .get(payload.session_id)
        .pipe(Effect.catchAll(() => Effect.succeed(null)))
      const engaged = prior?.engagement_required === true
      let resetOk = false
      if (!engaged) {
        const resetE = yield* Effect.either(state.reset(payload.session_id))
        resetOk = resetE._tag === "Right"
      }
      const base = engaged
        ? `Switched to project ${path.basename(newRoot)}. Engagement active — session state preserved.`
        : `Switched to project ${path.basename(newRoot)}.${
            resetOk ? " Session state reset." : ""
          }`
      const ctx = hasLocalConfig
        ? `${base} Project-local config loaded.`
        : base
      return {
        hookSpecificOutput: {
          hookEventName: "CwdChanged",
          additionalContext: ctx,
        },
      }
    }

    if (hasLocalConfig) {
      return {
        hookSpecificOutput: {
          hookEventName: "CwdChanged",
          additionalContext: `Project-local hook config detected at ${localConfig}/`,
        },
      }
    }
    return NO_DECISION
  })
