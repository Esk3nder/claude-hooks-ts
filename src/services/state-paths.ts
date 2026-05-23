import * as crypto from "node:crypto"
import * as path from "node:path"
import { Effect } from "effect"
import { currentProcessEnv, type EnvMap } from "../bootstrap/env.ts"
import { CommandRunner } from "./command-runner.ts"
import { detectSessionRoot } from "./project-root.ts"

const SAFE_SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/

const hashSuffix = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)

const slugSegment = (value: string, fallback: string): string => {
  const slug = value
    .trim()
    .replace(/[\\/]/g, "-")
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/\.\.+/g, ".")
    .replace(/^[.-]+/, "")
    .slice(0, 80)
  return slug.length > 0 ? slug : fallback
}

export const safeStateSegment = (
  value: string,
  fallback = "state",
): string => {
  const trimmed = value.trim()
  if (
    SAFE_SEGMENT_RE.test(trimmed) &&
    !trimmed.includes("..") &&
    trimmed !== "." &&
    trimmed !== ".."
  ) {
    return trimmed
  }
  return `${slugSegment(value, fallback)}-${hashSuffix(value)}`
}

export const stateDirectory = (root: string): string =>
  path.join(root, ".claude-hooks", "state")

export const sessionStatePathForRoot = (
  root: string,
  sessionId: string,
): string =>
  path.join(stateDirectory(root), `${safeStateSegment(sessionId, "session")}.json`)

export const sessionStatePath = (input: {
  readonly root: string
  readonly sessionId: string
  readonly sessionRoot?: string | null | undefined
}): string =>
  sessionStatePathForRoot(input.sessionRoot ?? input.root, input.sessionId)

export const stateRootForHook = (
  cwd: string = process.cwd(),
  env: EnvMap = currentProcessEnv(),
): Effect.Effect<string, never, CommandRunner> => {
  const override = env["CLAUDE_HOOKS_STATE_ROOT"]
  return typeof override === "string" && override.trim().length > 0
    ? Effect.succeed(path.resolve(override))
    : detectSessionRoot(cwd)
}
