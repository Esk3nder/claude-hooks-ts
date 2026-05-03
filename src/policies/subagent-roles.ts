/**
 * Subagent role → scope rules + investigation classification.
 */

export type SubagentMode = "read-only" | "write-allowed" | "unknown"

export interface RoleSpec {
  readonly mode: SubagentMode
  readonly investigative: boolean
  readonly scopeRule: string
}

const READ_ONLY_RULE =
  "You are a read-only investigator. Return concise findings with file paths, line references, confidence, and next recommended action. Do not modify files."

const WRITE_RULE =
  "You may modify files within the project. Stay in scope. Report exact paths edited, commands run, and verification steps."

const ROLES: Record<string, RoleSpec> = {
  Explore: { mode: "read-only", investigative: true, scopeRule: READ_ONLY_RULE },
  Plan: { mode: "read-only", investigative: true, scopeRule: READ_ONLY_RULE },
  "docs-researcher": {
    mode: "read-only",
    investigative: true,
    scopeRule: READ_ONLY_RULE,
  },
  "security-reviewer": {
    mode: "read-only",
    investigative: true,
    scopeRule: READ_ONLY_RULE,
  },
  "perf-auditor": {
    mode: "read-only",
    investigative: true,
    scopeRule: READ_ONLY_RULE,
  },
  "test-writer": {
    mode: "write-allowed",
    investigative: false,
    scopeRule: WRITE_RULE,
  },
  "general-purpose": {
    mode: "write-allowed",
    investigative: false,
    scopeRule: WRITE_RULE,
  },
}

const UNKNOWN_SPEC: RoleSpec = {
  mode: "unknown",
  investigative: false,
  scopeRule:
    "Stay in scope of your assigned task. Report file paths, commands, and confidence in your final message.",
}

export const lookupRole = (subagentType: string | undefined): RoleSpec => {
  if (!subagentType) return UNKNOWN_SPEC
  return ROLES[subagentType] ?? UNKNOWN_SPEC
}

const EVIDENCE_PATTERNS: ReadonlyArray<RegExp> = [
  /[\/\w.-]+\.[a-zA-Z]+:\d+/, // path:line
  /[\/\w.-]+\.[a-zA-Z]+\b/, // file path with extension
  /\bconfidence\s*[:=]/i,
  /\$\s+\S+/, // shell command marker
  /\bran\b|\bexecuted\b|\bcommand\b/i,
  /\bL\d+\b/, // L42 line refs
]

export const hasEvidence = (text: string | undefined): boolean => {
  if (!text || text.trim().length === 0) return false
  return EVIDENCE_PATTERNS.some((p) => p.test(text))
}
