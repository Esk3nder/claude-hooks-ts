/**
 * US-22 — Generated classifier contract.
 *
 * Single source of truth for the classifier's deterministic gate surface:
 * which tokens fast-path to MINIMAL, which regex patterns mark
 * system-injected text, the minimum prompt length threshold, and the
 * ordered list of pre-inference gates. The contract is regenerated from
 * the live classifier module via `bun run contract:generate`. CI runs
 * `bun run contract:check` to fail any PR that mutates classifier
 * behavior without regenerating `docs/CLASSIFIER_CONTRACT.json`.
 *
 * Why: the external-review reconciliation surfaced silent drift between
 * documentation and behavior (claimed regexes that didn't exist, missing
 * tokens, incorrect layer ownership). A generated artifact closes that
 * class of bug — reviewers can quote the artifact with confidence,
 * because if it's wrong the test and the CI check both fail.
 */

import {
  MIN_PROMPT_LENGTH,
  POSITIVE_PHRASES,
  POSITIVE_PRAISE_WORDS,
  SHORT_CONTEXT_TOKENS,
  SYSTEM_TEXT_PATTERNS,
} from "./classifier.ts"

/** Contract version. Bump when the JSON shape changes (NOT when the data
 * inside changes — data changes are tracked by the artifact itself). */
export const CONTRACT_VERSION = "1.0.0"

export interface ClassifierContract {
  readonly version: string
  readonly generatedFrom: string
  readonly fastPath: {
    readonly gates: ReadonlyArray<{
      readonly order: number
      readonly name: string
      readonly result: string
      readonly reason?: string
      readonly suppressedWhen?: string
      readonly delegatesWhen?: string
    }>
  }
  readonly constants: {
    readonly minPromptLength: number
    readonly shortContextTokens: ReadonlyArray<string>
    readonly positivePraiseWords: ReadonlyArray<string>
    readonly positivePhrases: ReadonlyArray<string>
    readonly systemTextPatterns: ReadonlyArray<string>
  }
  readonly failSafe: {
    readonly trigger: string
    readonly result: string
  }
}

const sorted = (s: ReadonlySet<string>): ReadonlyArray<string> =>
  Array.from(s).sort()

/** Pure function: build the contract from live module imports.
 * Deterministic — same inputs produce byte-identical output. */
export const buildClassifierContract = (): ClassifierContract => ({
  version: CONTRACT_VERSION,
  generatedFrom: "src/algorithm/classifier.ts",
  fastPath: {
    gates: [
      {
        order: 1,
        name: "explicit-rating",
        result: "MINIMAL",
        reason: "explicit rating",
      },
      {
        order: 2,
        name: "positive-praise",
        result: "MINIMAL",
        reason: "positive praise / acknowledgment",
        suppressedWhen: "hasCodeContextInRecent(recentContext) === true",
      },
      {
        order: 3,
        name: "system-text",
        result: "handled by prompt-router BEFORE classify() — no additionalContext emitted",
      },
      {
        order: 4,
        name: "short-prompt",
        result: "MINIMAL",
        reason: "prompt too short for classification",
        delegatesWhen:
          "prompt.trim().toLowerCase() ∈ SHORT_CONTEXT_TOKENS AND hasPendingWorkSignal(recentContext)",
      },
    ],
  },
  constants: {
    minPromptLength: MIN_PROMPT_LENGTH,
    shortContextTokens: sorted(SHORT_CONTEXT_TOKENS),
    positivePraiseWords: sorted(POSITIVE_PRAISE_WORDS),
    positivePhrases: sorted(POSITIVE_PHRASES),
    systemTextPatterns: SYSTEM_TEXT_PATTERNS.map((re) => re.source),
  },
  failSafe: {
    trigger:
      "classifier subprocess failure OR runtime config classifierDisabled === true",
    result: "ALGORITHM E3",
  },
})

/** Serialize a contract to the canonical artifact form. Stable key order,
 * 2-space indent, trailing newline — so `git diff --exit-code` is
 * meaningful and merge conflicts are minimal. */
export const serializeContract = (c: ClassifierContract): string =>
  JSON.stringify(c, null, 2) + "\n"
