import { matchesAnyGlob } from "./path-utils.ts"
import type { PolicyDecision } from "./types.ts"

/** System / repo-critical paths that warrant `ask` before edit/write. */
export const PROTECTED_PATH_GLOBS: ReadonlyArray<string> = [
  "/etc/**",
  "/usr/**",
  "/bin/**",
  "/sbin/**",
  "**/.git/**",
  "**/.github/workflows/**",
  "**/Dockerfile",
  "**/docker-compose*.yml",
  "**/docker-compose*.yaml",
  "**/Makefile",
  "**/CODEOWNERS",
  "**/.husky/**",
  "**/.pre-commit-config.yaml",
]

export const evaluateProtectedPath = (filePath: string): PolicyDecision => {
  const hit = matchesAnyGlob(filePath, PROTECTED_PATH_GLOBS)
  if (hit === undefined) return { kind: "passthrough" }
  return {
    kind: "ask",
    reason: `Edit of protected path requires confirmation (matched ${hit}).`,
  }
}
