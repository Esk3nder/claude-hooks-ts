/**
 * Stable session-root detection.
 *
 * The engagement gate, Stop ISA lookup, and TaskCompleted evidence lookup
 * all need a root that does NOT change when Bash `cd` moves the shell.
 * `detectSessionRoot` is called once at engagement creation and frozen in
 * SessionState so later hook invocations use the same value regardless of
 * `payload.cwd`.
 *
 * Resolution order:
 *   1. `git rev-parse --show-toplevel` from `cwd` (canonical project root).
 *   2. `cwd` as given.
 *   3. `process.cwd()`.
 *
 * A 500ms timeout caps git misbehavior. Command execution goes through the
 * shared CommandRunner so env handling, timeout, and cleanup policy stay in
 * one place.
 */
import { Effect } from "effect"
import { existsSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import { CommandRunner } from "./command-runner.ts"

const normalizeExistingOrResolved = (p: string): string => {
  const abs = resolve(p)
  if (!existsSync(abs)) return abs
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

export const detectSessionRoot = (cwd: string = process.cwd()): Effect.Effect<string, never, CommandRunner> =>
  Effect.gen(function* () {
  const base =
    typeof cwd === "string" && cwd.length > 0
      ? normalizeExistingOrResolved(cwd)
      : normalizeExistingOrResolved(process.cwd())

    const runner = yield* CommandRunner
    const result = yield* runner
      .run("git", ["rev-parse", "--show-toplevel"], {
        cwd: base,
        timeoutMs: 500,
        stdoutMaxBytes: 4_096,
        stderrMaxBytes: 4_096,
      })
      .pipe(Effect.catchAll(() => Effect.succeed(null)))
    const root = result !== null && result.exitCode === 0 && !result.timedOut ? result.stdout.trim() : ""
    if (root.length > 0) {
      return normalizeExistingOrResolved(root)
    }
    return base
  })
