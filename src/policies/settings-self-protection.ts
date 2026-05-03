import { matchesAnyGlob } from "./path-utils.ts"
import type { PolicyDecision } from "./types.ts"

/**
 * Paths comprising the agent's own control plane. Editing these can let the
 * agent disable its own guardrails — always require explicit user confirmation.
 */
export const SETTINGS_GLOBS: ReadonlyArray<string> = [
  "**/.claude/settings.json",
  "**/.claude/settings.*.json",
  "**/.claude/settings.local.json",
  "**/.claude/hooks/**",
  "**/.claude/agents/**",
  "**/.claude/policies/**",
  "**/.claude/permissions/**",
  "**/.claude/permissions.json",
  "**/.claude-hooks/**",
  "~/.claude/settings.json",
  "~/.claude/settings.*.json",
  "~/.claude/hooks/**",
  "~/.claude/agents/**",
  "~/.claude/policies/**",
]

export const evaluateSettingsSelfProtection = (
  filePath: string,
): PolicyDecision => {
  const hit = matchesAnyGlob(filePath, SETTINGS_GLOBS)
  if (hit === undefined) return { kind: "passthrough" }
  return {
    kind: "ask",
    reason: `Modifying agent control-plane file requires user confirmation (matched ${hit}).`,
  }
}
