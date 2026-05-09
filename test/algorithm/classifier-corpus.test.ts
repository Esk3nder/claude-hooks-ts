import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { classify, tryFastPath } from "../../src/algorithm/classifier.ts"
import {
  Inference,
  InferenceTest,
  type Mode,
  type Tier,
} from "../../src/services/inference.ts"
import { ClaudeSubprocessTest } from "../../src/services/claude-subprocess.ts"

/**
 * 24-prompt regression corpus, doctrine-aligned with PAI's pre-inference
 * gates. Fast-path cases mirror the four PAI gates exactly:
 *   - rating       (isExplicitRating, PAI line 101-113)
 *   - praise       (POSITIVE_PRAISE_WORDS / POSITIVE_PHRASES, PAI line 115-123)
 *   - system text  (SYSTEM_TEXT_PATTERNS, PAI line 125-131)
 *   - short prompt (length < MIN_PROMPT_LENGTH = 3, PAI line 905)
 *
 * NOT fast-path per PAI doctrine (single-word approvals, /eN, "thanks") all
 * route to Inference because the Sonnet classifier needs conversation context
 * to disambiguate per Algorithm v6.3.0 line 749.
 */

interface Case {
  readonly prompt: string
  readonly expect:
    | { readonly via: "fast-path"; readonly mode: Mode; readonly tier: Tier | null }
    | { readonly via: "inference" }
}

const CORPUS: ReadonlyArray<Case> = [
  // Gate 1 — explicit rating (PAI isExplicitRating)
  { prompt: "8", expect: { via: "fast-path", mode: "MINIMAL", tier: null } },
  { prompt: "10", expect: { via: "fast-path", mode: "MINIMAL", tier: null } },
  { prompt: "7 - good work", expect: { via: "fast-path", mode: "MINIMAL", tier: null } },
  { prompt: "8 things to fix", expect: { via: "inference" } }, // sentence-starter exclusion

  // Gate 2 — positive praise (POSITIVE_PRAISE_WORDS / POSITIVE_PHRASES)
  { prompt: "excellent", expect: { via: "fast-path", mode: "MINIMAL", tier: null } },
  { prompt: "amazing", expect: { via: "fast-path", mode: "MINIMAL", tier: null } },
  { prompt: "perfect", expect: { via: "fast-path", mode: "MINIMAL", tier: null } },
  { prompt: "great job", expect: { via: "fast-path", mode: "MINIMAL", tier: null } },
  { prompt: "well done", expect: { via: "fast-path", mode: "MINIMAL", tier: null } },
  { prompt: "looks great", expect: { via: "fast-path", mode: "MINIMAL", tier: null } },

  // Gate 3 (system text) is now handled by the prompt-router BEFORE
  // tryFastPath, mirroring PAI's process.exit(0). Tested separately in
  // tryFastPath/system-text.test.ts via isSystemTextPrompt().

  // Gate 4 — short prompt (< 3 chars)
  { prompt: "", expect: { via: "fast-path", mode: "MINIMAL", tier: null } },
  { prompt: "hi", expect: { via: "fast-path", mode: "MINIMAL", tier: null } },

  // PAI Gate 4 wins for length<3 ("ok", "no") BEFORE the doctrine's
  // single-word-approval rule can fire (which lives inside Sonnet's
  // classification, not in the pre-filter). PAI hook line 905.
  { prompt: "ok", expect: { via: "fast-path", mode: "MINIMAL", tier: null } },
  // PAI doctrine: 3+ char single-word approvals → inference (need context)
  { prompt: "yes", expect: { via: "inference" } },
  { prompt: "thanks", expect: { via: "inference" } },

  // PAI doctrine: /eN is executor-side, classifier still classifies content
  { prompt: "/e3 do the migration", expect: { via: "inference" } },

  // Genuinely ambiguous → inference
  { prompt: "implement OAuth refresh flow", expect: { via: "inference" } },
  { prompt: "fix the bug in stop handler", expect: { via: "inference" } },
  { prompt: "what does the dispatcher do", expect: { via: "inference" } },
  { prompt: "review this PR", expect: { via: "inference" } },
  { prompt: "deploy to production", expect: { via: "inference" } },
  { prompt: "audit the algorithm and update doctrine", expect: { via: "inference" } },
  { prompt: "should we use postgres or mysql?", expect: { via: "inference" } },
  { prompt: "ok now also fix the database", expect: { via: "inference" } },
]

describe("classifier corpus — PAI-aligned (24 cases)", () => {
  test(`corpus has at least 24 cases (got ${CORPUS.length})`, () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(24)
  })

  for (const c of CORPUS) {
    const label = c.prompt.length === 0 ? "<empty>" : c.prompt.slice(0, 50)
    test(`[${c.expect.via}] "${label}"`, async () => {
      const fast = tryFastPath(c.prompt)
      if (c.expect.via === "fast-path") {
        expect(fast).not.toBeNull()
        if (fast !== null) {
          expect(fast.mode).toBe(c.expect.mode)
          expect(fast.tier).toBe(c.expect.tier)
        }
      } else {
        expect(fast).toBeNull()
      }
    })
  }

  test("fast-path cases never invoke Inference", async () => {
    let inferenceCalls = 0
    const layer = InferenceTest(() => {
      inferenceCalls++
      return {
        mode: "ALGORITHM",
        tier: 3,
        reason: "should not be called",
        source: "fail-safe",
        latencyMs: 0,
      }
    })
    const fastCases = CORPUS.filter((c) => c.expect.via === "fast-path")
    for (const c of fastCases) {
      await Effect.runPromise(
        classify(c.prompt).pipe(
          Effect.provide(layer),
          Effect.provide(ClaudeSubprocessTest()),
        ),
      )
    }
    expect(inferenceCalls).toBe(0)
  })

  test("inference cases each call Inference exactly once", async () => {
    const inferenceCases = CORPUS.filter((c) => c.expect.via === "inference")
    let inferenceCalls = 0
    const layer = InferenceTest((p) => {
      inferenceCalls++
      void p
      return {
        mode: "ALGORITHM",
        tier: 3,
        reason: "from corpus test",
        source: "classifier",
        latencyMs: 50,
      }
    })
    for (const c of inferenceCases) {
      const result = await Effect.runPromise(
        classify(c.prompt).pipe(
          Effect.provide(layer),
          Effect.provide(ClaudeSubprocessTest()),
        ),
      )
      expect(result.source).toBe("classifier")
    }
    expect(inferenceCalls).toBe(inferenceCases.length)
  })

  test("Inference symbol resolved", () => {
    expect(Inference).toBeDefined()
  })
})
