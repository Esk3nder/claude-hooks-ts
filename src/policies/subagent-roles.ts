/**
 * Subagent role → scope rules + investigation classification.
 */

export type SubagentMode = "read-only" | "write-allowed" | "unknown"

export interface RoleSpec {
  readonly mode: SubagentMode
  readonly investigative: boolean
  readonly scopeRule: string
  readonly outputContract: string
  // Planning-style roles produce recommendations and risk language but
  // rarely cite a file:line. They still must return substance, so we
  // require judgment language only, not an anchor.
  readonly judgmentOnly?: boolean
}

const READ_ONLY_RULE =
  "You are a read-only investigator. Return concise findings with file paths, line references, confidence, and next recommended action. Do not modify files."

const WRITE_RULE =
  "You may modify files within the project. Stay in scope. Report exact paths edited, commands run, and verification steps."

const READ_ONLY_OUTPUT =
  "Output contract: return markdown directly in the final assistant message; do not wrap it in JSON. Include summary, concrete evidence anchors (file:line or command run), confidence, risks/blockers, and next recommended action."

const PLANNER_OUTPUT =
  "Output contract: return markdown directly in the final assistant message; do not wrap it in JSON. Include summary, concrete recommendations, risks/blockers, next steps, and confidence. file:line anchors are encouraged but not required."

const WRITE_OUTPUT =
  "Output contract: return markdown directly in the final assistant message; do not wrap it in JSON. Include summary, exact paths edited (or state no edits), commands run, verification result, risks, and any orchestrator handoff needed."

const UNKNOWN_OUTPUT =
  "Output contract: return markdown directly in the final assistant message; do not wrap it in JSON. Include summary, file paths, commands run, confidence, and any blocker or handoff needed."

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
    outputContract: PLANNER_OUTPUT,
    judgmentOnly: true,
  },
  planner: {
    mode: "read-only",
    investigative: true,
    scopeRule: READ_ONLY_RULE,
    outputContract: PLANNER_OUTPUT,
    judgmentOnly: true,
  },
  architect: {
    mode: "read-only",
    investigative: true,
    scopeRule: READ_ONLY_RULE,
    outputContract: PLANNER_OUTPUT,
    judgmentOnly: true,
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
  /"verification"\s*:/i,
  /"files_relevant"\s*:/i,
]

const CONFIDENCE_PATTERN =
  /(?:\bconfidence\s*[:=]\s*|"confidence"\s*:\s*")(?:low|medium|high|none|unknown|tbd|[0-9]+(?:\.[0-9]+)?%?)\b/i
const NEXT_ACTION_PATTERN =
  /\b(?:next\s*(?:step|steps|action|actions)\b|next\s*[:=]|recommend(?:ed|ation|s)?\b|risk\b|risks\b|blocker\b|blockers\b|handoff\b)/i

export interface EvidenceOptions {
  readonly judgmentOnly?: boolean
}

export const hasEvidence = (
  text: string | undefined,
  options: EvidenceOptions = {},
): boolean => {
  if (!text || text.trim().length === 0) return false
  const hasAnchor = EVIDENCE_PATTERNS.some((p) => p.test(text))
  const hasJudgment =
    CONFIDENCE_PATTERN.test(text) || NEXT_ACTION_PATTERN.test(text)
  if (options.judgmentOnly) return hasJudgment
  return hasAnchor && hasJudgment
}
