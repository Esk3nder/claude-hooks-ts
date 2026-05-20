/**
 * Classifier tier-inflation guard (US-3).
 *
 * The Sonnet rubric biases UP — "when in doubt between two ALGORITHM tiers,
 * pick the higher one" — which is good for catching scope hidden in short
 * sentences but bad when a short, low-evidence prompt routes to E4/E5 just
 * because the rubric prefers escalation.
 *
 * This guard runs AFTER inference returns and floors the tier to 3 when the
 * classifier said ≥ 4 but neither the prompt nor the recent context shows
 * structural evidence of cross-cutting / multi-file work. It never escalates,
 * never demotes below 3 (that would skip engagement entirely), and emits a
 * telemetry record so the floor rate is observable.
 *
 * Pure logic; no I/O. Wired in from `src/services/inference.ts` after
 * `parseClassifierResponse` returns.
 */

import type { Mode, Tier } from "../services/inference.ts"

export interface StructuralEvidenceInput {
  readonly prompt: string
  readonly context?: string
  readonly tier: Tier | null
}

export interface StructuralEvidenceResult {
  readonly pass: boolean
  readonly floorTier: Tier
  /** Human-readable reason for telemetry. Always populated. */
  readonly reason: string
}

/** Three or more file-path-shaped tokens in a single string. */
const FILE_PATH_RE =
  /(?:^|[\s(`'"])[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|java|kt|swift|c|h|cpp|hpp|cc|cs|php|sh|bash|zsh|fish|sql|json|ya?ml|toml|md)\b/gi
/** Matches absolute (`/x/y`), relative (`./x` or `../x`), and bare-relative
 * (`src/foo`, `lib/baz`) paths. Bare-relative requires a word-char on each
 * side of the slash to avoid matching English fragments like "and/or". */
const SLASH_PATH_RE = /(?:(?:^|[\s(`'"])\.{0,2}\/[\w./-]+|\b\w[\w-]*\/\w[\w./-]*)/g
const CODE_FENCE_RE = /```/

/** Verbs that, on their own, are a strong signal of cross-cutting work. */
const STRUCTURAL_VERBS_RE =
  /\b(?:multi-?(?:step|file|module)|cross-?(?:cutting|vendor|file|module|repo)|architecture|doctrine|refactor(?:ing)?|migrate|migration|consolidat\w+|deprecat\w+|backfill|rollout|orchestrat\w+|end-?to-?end)\b/i

/** ISA / engagement references — if the prompt or context mentions an
 * active engagement, the work continues prior cross-cutting effort. */
const ISA_REF_RE = /(?:\bISA\.md|\.claude-hooks\/work\/|engaged-tier|expected_isa_path)/i

/**
 * Count distinct file-path-shaped tokens in a string. Used to detect "the
 * prompt names ≥3 files" structural signal.
 */
const countFilePathLikeTokens = (s: string): number => {
  if (s.length === 0) return 0
  const seen = new Set<string>()
  for (const m of s.matchAll(FILE_PATH_RE)) {
    const tok = m[0].trim()
    if (tok.length > 0) seen.add(tok)
  }
  for (const m of s.matchAll(SLASH_PATH_RE)) {
    const tok = m[0].trim()
    if (tok.length > 0) seen.add(tok)
  }
  return seen.size
}

/**
 * Return true if `s` contains at least one structural-evidence signal.
 * Exported so US-3's classifier helper and future stories (US-11) can share.
 */
export const hasStructuralSignal = (s: string): boolean => {
  if (s.length === 0) return false
  if (CODE_FENCE_RE.test(s)) return true
  if (countFilePathLikeTokens(s) >= 3) return true
  if (STRUCTURAL_VERBS_RE.test(s)) return true
  if (ISA_REF_RE.test(s)) return true
  return false
}

/**
 * Check whether a classification at tier ≥ 4 has structural evidence to
 * justify it. Returns `{ pass: true, floorTier: 4 | 5 }` when the original
 * tier should stand, or `{ pass: false, floorTier: 3 }` with a reason when
 * the tier should be floored.
 *
 * Tiers 1–3 and MINIMAL/NATIVE are always passed through (no normalization).
 */
export const checkStructuralEvidence = (
  input: StructuralEvidenceInput,
): StructuralEvidenceResult => {
  const { prompt, context, tier } = input
  if (tier === null || tier < 4) {
    return {
      pass: true,
      floorTier: (tier ?? 3) as Tier,
      reason: "tier < 4; no normalization",
    }
  }
  // Combined search surface — either source alone is sufficient.
  const promptSignal = hasStructuralSignal(prompt)
  const contextSignal = context !== undefined && hasStructuralSignal(context)
  if (promptSignal || contextSignal) {
    return {
      pass: true,
      floorTier: tier,
      reason: promptSignal
        ? "structural signal in prompt"
        : "structural signal in recent context",
    }
  }
  return {
    pass: false,
    floorTier: 3,
    reason: `tier ${tier} floored to 3: no code blocks, ≥3 file paths, structural verbs, or ISA references in prompt or recent context`,
  }
}

// ──────────────────────────────────────────────────────────────────────
// US-3c — Deflation guard (symmetric counterpart to checkStructuralEvidence)
// ──────────────────────────────────────────────────────────────────────

/**
 * Under-classification guard. Symmetric to `checkStructuralEvidence`: that
 * one floors over-classified tiers DOWN; this one floors under-classified
 * MINIMAL/NATIVE verdicts UP to ALGORITHM E1 when the prompt or recent
 * context shows the same structural signals.
 *
 * The asymmetry in the floor target is deliberate. Inflation floors to E3
 * because that's the lowest engaged tier — anything below would skip
 * engagement entirely. Deflation floors to E1 because the prompt was
 * classified as trivial; E1 is the lightest engaged tier and the right
 * step up. Crossing into E3+ from MINIMAL would be too aggressive a
 * correction.
 *
 * Only fires when:
 *   - mode is MINIMAL or NATIVE (already-ALGORITHM is passed through —
 *     the inflation guard handles that direction)
 *   - prompt OR context contains a structural signal
 */

export interface UnderClassificationInput {
  readonly prompt: string
  readonly context?: string
  readonly mode: Mode
  readonly tier: Tier | null
}

export interface UnderClassificationResult {
  readonly pass: boolean
  readonly floorMode?: Mode
  readonly floorTier?: Tier
  readonly reason: string
}

export const checkUnderClassification = (
  input: UnderClassificationInput,
): UnderClassificationResult => {
  if (input.mode !== "MINIMAL" && input.mode !== "NATIVE") {
    return { pass: true, reason: "mode is ALGORITHM; no escalation" }
  }
  const promptSignal = hasStructuralSignal(input.prompt)
  const contextSignal =
    input.context !== undefined && hasStructuralSignal(input.context)
  if (!promptSignal && !contextSignal) {
    return { pass: true, reason: "no structural signal; no escalation" }
  }
  const where = promptSignal ? "prompt" : "recent context"
  return {
    pass: false,
    floorMode: "ALGORITHM",
    floorTier: 1,
    reason: `${input.mode} escalated to ALGORITHM E1: structural signal in ${where} [deflation-guard]`,
  }
}
