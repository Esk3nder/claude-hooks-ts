import { Effect } from "effect"
import * as path from "node:path"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { FileSystem } from "../services/filesystem.ts"

/**
 * CwdChanged — when the new cwd has a project-local `.claude-hooks/`
 * directory, inject a one-line additionalContext flagging it. Otherwise
 * SAFE_DEFAULT.
 */
export const handleCwdChanged = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, FileSystem> =>
  Effect.gen(function* () {
    if (payload._tag !== "CwdChanged") return SAFE_DEFAULT
    const fs = yield* FileSystem
    const localConfig = path.join(payload.new_cwd, ".claude-hooks")
    const existsE = yield* Effect.either(fs.exists(localConfig))
    if (existsE._tag === "Right" && existsE.right) {
      return {
        hookSpecificOutput: {
          hookEventName: "CwdChanged",
          additionalContext: `Project-local hook config detected at ${localConfig}/`,
        },
      }
    }
    return SAFE_DEFAULT
  })
