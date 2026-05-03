import { matchesAnyGlob, normalizePath } from "./path-utils.ts"
import type { PolicyDecision } from "./types.ts"

/** Paths that must never be read by the model. */
export const SECRET_PATH_GLOBS: ReadonlyArray<string> = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa",
  "**/id_rsa.pub",
  "**/id_ed25519",
  "**/id_ed25519.pub",
  "**/.npmrc",
  "**/.pypirc",
  "**/.netrc",
  "**/credentials",
  "**/credentials.json",
  "**/.aws/credentials",
  "**/.aws/config",
  "**/.config/gcloud/**",
  "**/.kube/config",
  "**/.ssh/**",
]

/** Allow-list of safe variants that look like secrets but aren't. */
const ALLOWLIST: ReadonlyArray<string> = [
  "**/.env.example",
  "**/.env.sample",
  "**/.env.template",
  "**/.env.dist",
]

/** True if `.npmrc` actually contains an auth token (best-effort path check). */
const isAuthNpmrc = (path: string): boolean => path.endsWith("/.npmrc")

export const evaluateSecretPath = (filePath: string): PolicyDecision => {
  const norm = normalizePath(filePath)
  if (matchesAnyGlob(norm, ALLOWLIST) !== undefined) return { kind: "passthrough" }
  const hit = matchesAnyGlob(norm, SECRET_PATH_GLOBS)
  if (hit === undefined) return { kind: "passthrough" }
  // For .npmrc we still deny — path-only check is conservative-by-default.
  void isAuthNpmrc
  return {
    kind: "deny",
    reason: `Reading secret-bearing path is forbidden (matched ${hit}). If you need a value, ask the user or read .env.example for shape.`,
  }
}
