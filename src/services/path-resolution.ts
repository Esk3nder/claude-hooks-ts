/**
 * Shared path normalization used by the engagement gate and other
 * cwd-sensitive policies.
 *
 * `safeResolvePath` turns a possibly-relative, possibly-symlinked input
 * path into an absolute string that is safe to compare for equality:
 *
 *   1. Resolve against `cwd` → absolute path with `..` collapsed.
 *   2. If the path or any ancestor exists, follow symlinks via realpath
 *      on the deepest existing ancestor and re-attach the unresolved
 *      tail. This catches symlink-based bypasses where the path *string*
 *      looks safe but the *target* points outside the allowed area.
 *
 * Returns `null` if `input` is not a non-empty string.
 */
import { existsSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"

export const safeResolvePath = (cwd: string, input: unknown): string | null => {
  if (typeof input !== "string" || input.length === 0) return null
  const absolute = isAbsolute(input) ? input : resolve(cwd, input)
  let parent = absolute
  const tail: string[] = []
  while (parent !== dirname(parent)) {
    if (existsSync(parent)) break
    tail.unshift(parent.split("/").pop() ?? "")
    parent = dirname(parent)
  }
  if (existsSync(parent)) {
    try {
      const real = realpathSync(parent)
      return tail.length === 0 ? real : [real, ...tail].join("/")
    } catch {
      // realpath can fail on EPERM / ELOOP — fall through to the
      // resolved-but-not-realpathed form. The gate still rejects on
      // string equality, so this errs toward denying rather than
      // accidentally allowing a path that looked safe pre-realpath.
    }
  }
  return absolute
}
