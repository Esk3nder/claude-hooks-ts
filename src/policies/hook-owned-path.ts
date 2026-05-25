import * as path from "node:path"

/**
 * True when a tool-reported path points inside the active session's
 * hook-owned bookkeeping tree.
 *
 * Tool payloads may carry absolute paths or repo-relative paths. Normalize
 * through `sessionRoot` before comparing so `.claude-hooks/work/...` and
 * `/repo/.claude-hooks/work/...` are classified the same way, while
 * `fixtures/.claude-hooks/...` remains a normal project file.
 */
export const isSessionHookOwnedPath = (
  filePath: string,
  sessionRoot: string | null | undefined,
): boolean => {
  if (typeof filePath !== "string" || filePath.length === 0) return false
  if (typeof sessionRoot !== "string" || sessionRoot.length === 0) return false

  const rootAbs = path.resolve(sessionRoot)
  const fileAbs = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(rootAbs, filePath)
  const hookRoot = path.join(rootAbs, ".claude-hooks")
  const rel = path.relative(hookRoot, fileAbs)
  return rel.length === 0 || (!rel.startsWith("..") && !path.isAbsolute(rel))
}
