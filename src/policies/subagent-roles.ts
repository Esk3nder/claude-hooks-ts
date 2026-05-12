/**
 * Subagent role → scope rules + investigation classification.
 */

export type SubagentMode = "read-only" | "write-allowed" | "unknown"

export interface RoleSpec {
  readonly mode: SubagentMode
  readonly investigative: boolean
  readonly scopeRule: string
  readonly outputContract: string
}

const READ_ONLY_RULE =
  "You are a read-only investigator. Return concise findings with file paths, line references, confidence, and next recommended action. Do not modify files."

const WRITE_RULE =
  "You may modify files within the project. Stay in scope. Report exact paths edited, commands run, and verification steps."

const READ_ONLY_OUTPUT =
  "Output contract: return summary, concrete evidence anchors (file:line or command run), confidence, risks/blockers, and next recommended action."

const WRITE_OUTPUT =
  "Output contract: return summary, exact paths edited (or state no edits), commands run, verification result, risks, and any orchestrator handoff needed."

const UNKNOWN_OUTPUT =
  "Output contract: return summary, file paths, commands run, confidence, and any blocker or handoff needed."

const ROLES: Record<string, RoleSpec> = {
  Explore: {
    mode: "read-only",
    investigative: true,
    scopeRule: READ_ONLY_RULE,
    outputContract: READ_ONLY_OUTPUT,
  },
  explore: {
    mode: "read-only",
    investigative: true,
    scopeRule: READ_ONLY_RULE,
    outputContract: READ_ONLY_OUTPUT,
  },
  Plan: {
    mode: "read-only",
    investigative: true,
    scopeRule: READ_ONLY_RULE,
    outputContract: READ_ONLY_OUTPUT,
  },
  planner: {
    mode: "read-only",
    investigative: true,
    scopeRule: READ_ONLY_RULE,
    outputContract: READ_ONLY_OUTPUT,
  },
  architect: {
    mode: "read-only",
    investigative: true,
    scopeRule: READ_ONLY_RULE,
    outputContract: READ_ONLY_OUTPUT,
  },
  "docs-researcher": {
    mode: "read-only",
    investigative: true,
    scopeRule: READ_ONLY_RULE,
    outputContract: READ_ONLY_OUTPUT,
  },
  "security-reviewer": {
    mode: "read-only",
    investigative: true,
    scopeRule: READ_ONLY_RULE,
    outputContract: READ_ONLY_OUTPUT,
  },
  "perf-auditor": {
    mode: "read-only",
    investigative: true,
    scopeRule: READ_ONLY_RULE,
    outputContract: READ_ONLY_OUTPUT,
  },
  "test-writer": {
    mode: "write-allowed",
    investigative: false,
    scopeRule: WRITE_RULE,
    outputContract: WRITE_OUTPUT,
  },
  "general-purpose": {
    mode: "write-allowed",
    investigative: false,
    scopeRule: WRITE_RULE,
    outputContract: WRITE_OUTPUT,
  },
  executor: {
    mode: "write-allowed",
    investigative: false,
    scopeRule: WRITE_RULE,
    outputContract: WRITE_OUTPUT,
  },
  "test-engineer": {
    mode: "write-allowed",
    investigative: false,
    scopeRule: WRITE_RULE,
    outputContract: WRITE_OUTPUT,
  },
  "code-reviewer": {
    mode: "read-only",
    investigative: true,
    scopeRule: READ_ONLY_RULE,
    outputContract: READ_ONLY_OUTPUT,
  },
}

const UNKNOWN_SPEC: RoleSpec = {
  mode: "unknown",
  investigative: false,
  scopeRule:
    "Stay in scope of your assigned task. Report file paths, commands, and confidence in your final message.",
  outputContract: UNKNOWN_OUTPUT,
}

export const lookupRole = (subagentType: string | undefined): RoleSpec => {
  if (!subagentType) return UNKNOWN_SPEC
  return ROLES[subagentType] ?? UNKNOWN_SPEC
}

const EVIDENCE_PATTERNS: ReadonlyArray<RegExp> = [
  /[\/\w.-]+\.[a-zA-Z]+:\d+/, // path:line
  /\$\s+\S+/, // shell command marker
  /\b(?:ran|executed|command)\b/i,
]

const CONFIDENCE_PATTERN = /\bconfidence\s*[:=]\s*(?:low|medium|high|[0-9]+%?|\S+)/i
const NEXT_ACTION_PATTERN = /\b(?:next|recommend(?:ed|ation)?|risk|blocker|handoff)\b/i

export const hasEvidence = (text: string | undefined): boolean => {
  if (!text || text.trim().length === 0) return false
  const hasAnchor = EVIDENCE_PATTERNS.some((p) => p.test(text))
  const hasJudgment =
    CONFIDENCE_PATTERN.test(text) || NEXT_ACTION_PATTERN.test(text)
  return hasAnchor && hasJudgment
}
