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
 * Sync by design: hook handlers are short-lived and called frequently,
 * adding an async boundary here would complicate every caller for no
 * measurable win. A 500ms timeout caps git misbehavior.
 */
import { spawnSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { resolve } from "node:path"

const normalizeExistingOrResolved = (p: string): string => {
  const abs = resolve(p)
  if (!existsSync(abs)) return abs
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

export const detectSessionRoot = (cwd: string = process.cwd()): string => {
  const base =
    typeof cwd === "string" && cwd.length > 0
      ? normalizeExistingOrResolved(cwd)
      : normalizeExistingOrResolved(process.cwd())

  try {
    const out = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: base,
      encoding: "utf8",
      timeout: 500,
    })
    const root = typeof out.stdout === "string" ? out.stdout.trim() : ""
    if (out.status === 0 && root.length > 0) {
      return normalizeExistingOrResolved(root)
    }
  } catch {
    // non-git dir, missing git binary, invalid cwd, timeout — fall through
  }
  return base
}
