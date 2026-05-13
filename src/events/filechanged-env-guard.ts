import { Effect } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { NO_DECISION } from "../schema/decisions.ts"
import { matchesAnyGlob } from "../policies/path-utils.ts"
import { SECRET_PATH_GLOBS } from "../policies/secret-paths.ts"
import { LOCKFILE_GLOBS } from "../policies/lockfile-paths.ts"

const MANIFEST_GLOBS: ReadonlyArray<string> = [
  "**/package.json",
  "**/pyproject.toml",
  "**/Cargo.toml",
  "**/go.mod",
  "**/Gemfile",
  "**/requirements.txt",
  "**/composer.json",
]

/**
 * FileChanged handler — alert when sensitive files are modified
 * (.env, lockfiles, manifests). M2 emits an additionalContext note.
 * M3 will persist to the ledger.
 */
export const handleFileChanged = (
  payload: HookPayload,
): Effect.Effect<HookDecision> =>
  Effect.sync(() => {
    if (payload._tag !== "FileChanged") return NO_DECISION
    const path = payload.file_path
    const change = payload.change_type ?? "modified"
    const secretHit = matchesAnyGlob(path, SECRET_PATH_GLOBS)
    const lockHit = matchesAnyGlob(path, LOCKFILE_GLOBS)
    const manifestHit = matchesAnyGlob(path, MANIFEST_GLOBS)
    if (secretHit === undefined && lockHit === undefined && manifestHit === undefined) {
      return NO_DECISION
    }
    const tag =
      secretHit !== undefined
        ? "secret-bearing file"
        : lockHit !== undefined
          ? "lockfile"
          : "package manifest"
    const matched = secretHit ?? lockHit ?? manifestHit
    const note = `[filechanged-env-guard] ${tag} ${change}: ${path} (matched ${matched}). Verify the change is intentional.`
    const out: HookDecision = {
      hookSpecificOutput: {
        hookEventName: "FileChanged",
        additionalContext: note,
      },
    }
    return out
  })
