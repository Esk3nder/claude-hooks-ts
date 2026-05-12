/**
 * ISA lifecycle façade — pure planning and rendering helpers for the
 * UserPromptSubmit engagement directive.
 *
 * This module is the seam between classification (services/inference) and
 * the prompt-router handler: given a Classification, `planEngagement`
 * decides whether engagement is required and packages everything the
 * directive needs; `renderEngagementDirective` turns that plan into the
 * exact multi-line ENGAGE string the model sees.
 *
 * Behavior-preserving: the rendered string is byte-identical to the
 * previous in-handler composition in `events/prompt-router.ts`.
 *
 * Pure module: no Effect, no I/O.
 */
import type { Classification } from "../../services/inference.ts"
import type { IsaSectionName } from "./sections.ts"
import {
  EFFORT_BY_TIER,
  REQUIRED_SECTIONS_BY_TIER,
  expectedIsaPathFor,
  shouldRequireEngagement,
} from "./tier-policy.ts"

export interface EngagementPlan {
  readonly tier: 3 | 4 | 5
  readonly isaPath: string
  readonly effort: string
  readonly sections: ReadonlyArray<IsaSectionName>
}

/**
 * Decide whether the classification demands an ISA engagement and, if so,
 * return everything the directive renderer needs. Returns `null` for
 * MINIMAL, NATIVE, or ALGORITHM tier < 3 — the caller treats `null` as
 * "no engagement directive line, engagement_required = false".
 */
export const planEngagement = (
  c: Classification,
  sessionId: string,
): EngagementPlan | null => {
  if (!shouldRequireEngagement(c)) return null
  const tier = c.tier
  return {
    tier,
    isaPath: expectedIsaPathFor(sessionId),
    effort: EFFORT_BY_TIER[tier],
    sections: REQUIRED_SECTIONS_BY_TIER[tier],
  }
}

/**
 * Render the multi-line ENGAGE directive shown to the model as the third
 * additionalContext line. The exact wording, punctuation, and newline
 * placement are part of the contract — downstream gates and operator
 * expectations key on it — so changes here are observable behavior.
 */
export const renderEngagementDirective = (plan: EngagementPlan): string => {
  const sections = plan.sections.join(", ")
  return (
    `ENGAGE: ALGORITHM_ENGAGEMENT_REQUIRED=true | TIER=E${plan.tier} | ` +
    `ISA_PATH=${plan.isaPath}\n` +
    `MANDATORY FIRST ACTION before any non-ISA implementation work: ` +
    `create or update the ISA at \`${plan.isaPath}\` (or, if a project ISA ` +
    `exists at \`<repo>/ISA.md\`, append to it). ` +
    `Minimum frontmatter: \`effort: ${plan.effort}\`, \`phase: observe\`. ` +
    `Required sections for E${plan.tier}: ${sections}. ` +
    `Do not mark \`phase: complete\` until each ISC under \`## Criteria\` ` +
    `has matching evidence under \`## Verification\`. ` +
    `The Stop gate now blocks once if this run ends without an ISA at the ` +
    `expected path; absence is treated as failure, not noop. Skipping ISA ` +
    `creation is a CRITICAL FAILURE.`
  )
}
