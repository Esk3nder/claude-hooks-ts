/**
 * Tier completeness gate for ISA v2.7 / Algorithm v6.2.0+.
 *
 * NEW DESIGN (this package — not a port). this package's `skills/ISA/Workflows/CheckCompleteness.md`
 * describes the gate as a model-side workflow. This module is the
 * hook-readable version called out in IsaFormat.md line 213 as a forthcoming
 * patch. Required-section table is verbatim from IsaFormat.md lines 191-201:
 *
 * E1 | Goal, Criteria
 * E2 | Problem, Goal, Criteria, Test Strategy
 * E3 | Problem, Vision, Out of Scope, Constraints, Goal, Criteria, Features, Test Strategy
 * E4 | All twelve
 * E5 | All twelve + active Interview workflow run before BUILD
 *
 * Project ISA override (IsaFormat.md line 201): any `<project>/ISA.md`
 * requires E3+ structure regardless of task tier. Caller passes `isProjectIsa`
 * so we floor the tier to 3 for them.
 *
 * E5's "active Interview workflow run" is a model-side concern that hooks
 * cannot verify directly — we report `interviewRequired: true` so the
 * caller (Stop handler) can surface it as guidance, but we do NOT block
 * Stop on it.
 */

import { parseSections, type IsaSectionName } from "./sections.ts"
import { REQUIRED_SECTIONS_BY_TIER as TIER_POLICY_SECTIONS } from "./tier-policy.ts"

import type { Tier } from "../../services/inference.ts"

/**
 * Required section sets per tier — verbatim from IsaFormat.md lines 191-201.
 * Tiers 3-5 are sourced from the canonical `tier-policy.ts` so the Stop
 * completeness gate and the UserPromptSubmit engagement directive cannot
 * drift. Tiers 1-2 are declared here because they are not engagement
 * targets and so do not appear in tier-policy.
 */
export const REQUIRED_SECTIONS_BY_TIER: ReadonlyMap<
  Tier,
  ReadonlyArray<IsaSectionName>
> = new Map<Tier, ReadonlyArray<IsaSectionName>>([
  [1, ["Goal", "Criteria"]],
  [2, ["Problem", "Goal", "Criteria", "Test Strategy"]],
  [3, TIER_POLICY_SECTIONS[3]],
  [4, TIER_POLICY_SECTIONS[4]],
  [5, TIER_POLICY_SECTIONS[5]],
])

export interface CompletenessReport {
  /** Tier the check was evaluated against (after project-ISA flooring). */
  readonly tier: Tier
  /** True iff every required section was present. */
  readonly ok: boolean
  /** Required sections that the ISA does NOT contain. */
  readonly missing: ReadonlyArray<IsaSectionName>
  /** Required sections that ARE present. */
  readonly present: ReadonlyArray<IsaSectionName>
  /** True for E5 — caller may surface guidance but should NOT block on this. */
  readonly interviewRequired: boolean
}

export interface CheckCompletenessOptions {
  /** When true, floor the tier to 3 (project-ISA override per IsaFormat.md line 201). */
  readonly isProjectIsa?: boolean
}

/**
 * Check an ISA body against its tier's required-section set. Pure function;
 * does no I/O. Caller (Stop handler) decides whether to block or just warn.
 */
export const checkCompleteness = (
  content: string,
  taskTier: Tier,
  opts?: CheckCompletenessOptions,
): CompletenessReport => {
  const tier: Tier = opts?.isProjectIsa === true && taskTier < 3 ? 3 : taskTier
  const required = REQUIRED_SECTIONS_BY_TIER.get(tier) ?? []
  const present = parseSections(content)
  const missing: IsaSectionName[] = []
  const presentList: IsaSectionName[] = []
  for (const name of required) {
    if (present.has(name)) presentList.push(name)
    else missing.push(name)
  }
  return {
    tier,
    ok: missing.length === 0,
    missing,
    present: presentList,
    interviewRequired: tier === 5,
  }
}
