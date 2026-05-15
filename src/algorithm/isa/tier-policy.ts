/**
 * Canonical ISA tier policy — the single source of truth for tier-keyed
 * data used by the UserPromptSubmit engagement directive and the Stop
 * completeness gate.
 *
 * Extracted from `events/prompt-router.ts` so the directive renderer, the
 * completeness check, and any future tier-aware gate read from one place.
 *
 * `REQUIRED_SECTIONS_BY_TIER` reuses the canonical Map exported by
 * `completeness.ts` (which mirrors IsaFormat.md lines 191-201) and exposes
 * the engagement-relevant tiers (3-5) as a `Record<3|4|5, ...>` view —
 * the shape the directive renderer needs to index by literal tier.
 *
 * Pure module: no Effect, no I/O.
 */
import type { Classification } from "../../services/inference.ts"
import { safeStateSegment } from "../../services/state-paths.ts"
import { ISA_SECTIONS_V2_7, type IsaSectionName } from "./sections.ts"

/**
 * Required ISA sections per engagement tier — mirrors IsaFormat.md tier
 * completeness gate (E3 = 8 sections, E4/E5 = all 12). E1 and E2 are not
 * engagement targets here (the gate fires only at tier ≥ 3).
 *
 * This is the canonical source. `algorithm/isa/completeness.ts` builds its
 * full Map (which also covers tiers 1-2) by extending from these values,
 * so the directive string and the Stop completeness check cannot drift.
 */
export const REQUIRED_SECTIONS_BY_TIER: Record<
  3 | 4 | 5,
  ReadonlyArray<IsaSectionName>
> = {
  3: [
    "Problem",
    "Vision",
    "Out of Scope",
    "Constraints",
    "Goal",
    "Criteria",
    "Features",
    "Test Strategy",
  ],
  4: ISA_SECTIONS_V2_7,
  5: ISA_SECTIONS_V2_7,
}

/**
 * Frontmatter `effort:` token per tier. Surfaced in the engagement
 * directive so the model writes a frontmatter the Stop gate can parse.
 */
export const EFFORT_BY_TIER: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "standard",
  2: "extended",
  3: "advanced",
  4: "deep",
  5: "comprehensive",
}

/**
 * Compute the deterministic ISA path for a session. The slug is the raw
 * session_id so the path is reproducible from the payload alone — no model
 * guessing, no late binding. Stop / PostToolUse gates use the same field
 * (SessionState.expected_isa_path) so directive text and gate behavior agree.
 */
const EXPECTED_ISA_PATH_RE = /^\.claude-hooks\/work\/([^/]+)\/ISA\.md$/

export const normalizeExpectedIsaPath = (value: string | null): string | null => {
  if (value === null) return null
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "")
  const match = normalized.match(EXPECTED_ISA_PATH_RE)
  const slug = match?.[1]
  if (
    slug === undefined ||
    slug === "." ||
    slug === ".." ||
    slug.includes("..") ||
    safeStateSegment(slug, "session") !== slug
  ) {
    return null
  }
  return normalized
}

export const expectedIsaPathFor = (sessionId: string): string =>
  `.claude-hooks/work/${safeStateSegment(sessionId, "session")}/ISA.md`

/**
 * True iff the classification demands an ISA engagement (ALGORITHM tier ≥ 3).
 * Refines the classification type so callers can index `REQUIRED_SECTIONS_BY_TIER`
 * and `EFFORT_BY_TIER` without re-narrowing.
 */
export const shouldRequireEngagement = (
  c: Classification,
): c is Classification & { tier: 3 | 4 | 5 } =>
  c.mode === "ALGORITHM" && c.tier !== null && c.tier >= 3
