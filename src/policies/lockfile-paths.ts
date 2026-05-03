import { matchesAnyGlob } from "./path-utils.ts"
import type { PolicyDecision } from "./types.ts"

/** Lockfiles that should not be edited by hand. */
export const LOCKFILE_GLOBS: ReadonlyArray<string> = [
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/bun.lockb",
  "**/bun.lock",
  "**/Cargo.lock",
  "**/uv.lock",
  "**/poetry.lock",
  "**/Pipfile.lock",
  "**/go.sum",
  "**/composer.lock",
  "**/Gemfile.lock",
  "**/mix.lock",
]

export const evaluateLockfile = (filePath: string): PolicyDecision => {
  const hit = matchesAnyGlob(filePath, LOCKFILE_GLOBS)
  if (hit === undefined) return { kind: "passthrough" }
  return {
    kind: "ask",
    reason: `${filePath} is a lockfile (matched ${hit}); confirm before editing — prefer running the package manager (e.g. \`npm install\`, \`pnpm add\`, \`cargo update\`) so the lockfile is regenerated.`,
  }
}
