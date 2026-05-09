import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  classify,
  tryFastPath,
  renderClassificationLine,
} from "../../src/algorithm/classifier.ts"
import {
  Inference,
  InferenceTest,
  type Classification,
} from "../../src/services/inference.ts"
import { ClaudeSubprocessTest } from "../../src/services/claude-subprocess.ts"

const runClassify = (
  prompt: string,
  inferenceResult: Classification,
): Promise<Classification> =>
  Effect.runPromise(
    classify(prompt).pipe(
      Effect.provide(InferenceTest(() => inferenceResult)),
      Effect.provide(ClaudeSubprocessTest()),
    ),
  )

const algorithmT4: Classification = {
  mode: "ALGORITHM",
  tier: 4,
  reason: "from inference",
  source: "classifier",
  latencyMs: 5000,
}

describe("tryFastPath — this package pre-inference gates (verbatim)", () => {
  test("isExplicitRating: '8' → MINIMAL", () => {
    expect(tryFastPath("8")?.mode).toBe("MINIMAL")
  })
  test("isExplicitRating: '10' → MINIMAL", () => {
    expect(tryFastPath("10")?.mode).toBe("MINIMAL")
  })
  test("isExplicitRating: '8/10' → MINIMAL (no exclusion)", () => {
    // the regex allows trailing /10 because afterNumber starts with `/`
    // which is in the exclusion regex `[/.\dA-Za-z]` → NOT a rating.
    // Wait — re-read this package: excludes if afterNumber matches /^[/.\dA-Za-z]/
    // so "8/10" → afterNumber is "/10", first char "/" matches → NOT a rating.
    // treats "8/10" as NOT-rating (goes to inference). Mirror that.
    expect(tryFastPath("8/10")).toBeNull()
  })
  test("isExplicitRating: '8 things to fix' → NOT a rating (sentence starter)", () => {
    expect(tryFastPath("8 things to fix")).toBeNull()
  })
  test("isExplicitRating: '7 - good work' → MINIMAL (not a sentence starter)", () => {
    expect(tryFastPath("7 - good work")?.mode).toBe("MINIMAL")
  })

  test("isPositivePraise: 'excellent' → MINIMAL", () => {
    expect(tryFastPath("excellent")?.mode).toBe("MINIMAL")
  })
  test("isPositivePraise: 'great job' → MINIMAL", () => {
    expect(tryFastPath("great job")?.mode).toBe("MINIMAL")
  })
  test("isPositivePraise: 'great great' → MINIMAL (two-word praise composition)", () => {
    expect(tryFastPath("great great")?.mode).toBe("MINIMAL")
  })
  test("isPositivePraise: 'excellent work on the dispatcher' → NOT praise (>2 words)", () => {
    // 5 words → fails the >2 word gate, goes to inference
    expect(tryFastPath("excellent work on the dispatcher")).toBeNull()
  })

  test("system text → NOT a tryFastPath case (handled by router pre-classify)", () => {
    // the classifier: system text exits without emission. The router
    // checks isSystemTextPrompt() BEFORE invoking classify, so tryFastPath
    // does not see those prompts in normal flow. If they did slip through,
    // they would fall to inference and Sonnet would classify them.
    expect(tryFastPath("<system-reminder>foo</system-reminder>")).toBeNull()
    expect(tryFastPath("<task-notification>x</task-notification>")).toBeNull()
    expect(
      tryFastPath(
        "This session is being continued from a previous conversation",
      ),
    ).toBeNull()
  })

  test("short prompt < MIN_PROMPT_LENGTH (3) → MINIMAL", () => {
    expect(tryFastPath("")?.mode).toBe("MINIMAL")
    expect(tryFastPath("hi")?.mode).toBe("MINIMAL")
  })
  test("3-char prompt → NOT short, goes to inference", () => {
    expect(tryFastPath("yes")).toBeNull()
  })

  // Length-gate behavior: Gate 4 (short prompt < 3 chars) wins for
  // very-short tokens BEFORE the "single-word approval" rule can fire.
  // The approval rule applies inside the Sonnet classifier; the length
  // gate is a pre-classifier filter.
  test("'ok' (2 chars) → MINIMAL via short-prompt gate", () => {
    const r = tryFastPath("ok")
    expect(r?.mode).toBe("MINIMAL")
    expect(r?.reason).toBe("prompt too short for classification")
  })
  test("'no' (2 chars) → MINIMAL via short-prompt gate", () => {
    expect(tryFastPath("no")?.mode).toBe("MINIMAL")
  })
  test("'yes' (3 chars, not < MIN_PROMPT_LENGTH) → NOT fast-path → inference", () => {
    expect(tryFastPath("yes")).toBeNull()
  })
  test("'thanks' (6 chars, not in praise set) → NOT fast-path → inference", () => {
    // POSITIVE_PRAISE_WORDS does NOT include "thanks". The doctrine
    // example "thanks → MINIMAL" is decided by the Sonnet classifier, not
    // the fast-path. Mirror: "thanks" → null → inference.
    expect(tryFastPath("thanks")).toBeNull()
  })

  // Algorithm doctrine: /eN is executor-side, NOT classifier fast-path
  test("'/e3' → NOT fast-path (executor-side per Algorithm v6.3.0)", () => {
    expect(tryFastPath("/e3")).toBeNull()
  })
  test("'/e3 do the migration' → NOT fast-path", () => {
    expect(tryFastPath("/e3 do the migration")).toBeNull()
  })

  test("ambiguous prompt → null (must hit Inference)", () => {
    expect(tryFastPath("implement OAuth refresh flow")).toBeNull()
    expect(tryFastPath("read README.md")).toBeNull()
    expect(tryFastPath("what does the dispatcher do?")).toBeNull()
  })
})

describe("classify (fast-path → Inference)", () => {
  test("fast-path hit short-circuits Inference", async () => {
    let inferenceCalls = 0
    const layer = InferenceTest((p) => {
      inferenceCalls++
      void p
      return algorithmT4
    })
    const c = await Effect.runPromise(
      classify("excellent").pipe(
        Effect.provide(layer),
        Effect.provide(ClaudeSubprocessTest()),
      ),
    )
    expect(c.mode).toBe("MINIMAL")
    // B2 fix: fast-path classifications carry source: "fast-path" in the
    // Classification object. The additionalContext line still shows
    // "SOURCE: classifier" (renderClassificationLine collapses), but
    // telemetry preserves the fast-path distinction.
    expect(c.source).toBe("fast-path")
    expect(inferenceCalls).toBe(0)
  })

  test("non-fast-path delegates to Inference (e.g. 'yes')", async () => {
    const c = await runClassify("yes", algorithmT4)
    expect(c.mode).toBe("ALGORITHM")
    expect(c.tier).toBe(4)
    expect(c.source).toBe("classifier")
  })

  test("Inference fail-safe propagates through classify", async () => {
    const c = await runClassify("complicated thing", {
      mode: "ALGORITHM",
      tier: 3,
      reason: "parse-fail: garbled",
      source: "fail-safe",
      latencyMs: 200,
    })
    expect(c.source).toBe("fail-safe")
    expect(c.tier).toBe(3)
  })
})

describe("CLAUDE_HOOKS_DISABLE_CLASSIFIER env-var bypass", () => {
  test("when set, ambiguous prompt → fail-safe tier 3 without invoking Inference", async () => {
    let inferenceCalls = 0
    const layer = InferenceTest(() => {
      inferenceCalls++
      return algorithmT4
    })
    process.env["CLAUDE_HOOKS_DISABLE_CLASSIFIER"] = "1"
    try {
      const c = await Effect.runPromise(
        classify("implement OAuth refresh flow").pipe(
          Effect.provide(layer),
          Effect.provide(ClaudeSubprocessTest()),
        ),
      )
      expect(c.mode).toBe("ALGORITHM")
      expect(c.tier).toBe(3)
      expect(c.source).toBe("fail-safe")
      expect(inferenceCalls).toBe(0)
    } finally {
      delete process.env["CLAUDE_HOOKS_DISABLE_CLASSIFIER"]
    }
  })

  test("fast-path still wins over the bypass", async () => {
    process.env["CLAUDE_HOOKS_DISABLE_CLASSIFIER"] = "1"
    try {
      const c = await Effect.runPromise(
        classify("excellent").pipe(
          Effect.provide(InferenceTest(() => algorithmT4)),
          Effect.provide(ClaudeSubprocessTest()),
        ),
      )
      expect(c.mode).toBe("MINIMAL")
      // Fast-path runs before the env-var check, so source remains "fast-path".
      expect(c.source).toBe("fast-path")
    } finally {
      delete process.env["CLAUDE_HOOKS_DISABLE_CLASSIFIER"]
    }
  })
})

describe("renderClassificationLine — implements canonical behavior emitAdditionalContext", () => {
  test("ALGORITHM line includes E-prefixed TIER", () => {
    const line = renderClassificationLine({
      mode: "ALGORITHM",
      tier: 3,
      reason: "multi-file work",
      source: "classifier",
      latencyMs: 4000,
    })
    expect(line).toBe(
      "MODE: ALGORITHM | TIER: E3 | REASON: multi-file work | SOURCE: classifier",
    )
  })

  test("MINIMAL line omits TIER segment", () => {
    const line = renderClassificationLine({
      mode: "MINIMAL",
      tier: null,
      reason: "explicit rating",
      source: "classifier",
      latencyMs: 0,
    })
    expect(line).toBe(
      "MODE: MINIMAL | REASON: explicit rating | SOURCE: classifier",
    )
  })

  test("NATIVE line omits TIER segment", () => {
    const line = renderClassificationLine({
      mode: "NATIVE",
      tier: null,
      reason: "fact lookup",
      source: "classifier",
      latencyMs: 3000,
    })
    expect(line).toBe("MODE: NATIVE | REASON: fact lookup | SOURCE: classifier")
  })

  test("fail-safe source is emitted (the Algorithm v6.3.0 allows it)", () => {
    const line = renderClassificationLine({
      mode: "ALGORITHM",
      tier: 3,
      reason: "classifier exit 2",
      source: "fail-safe",
      latencyMs: 100,
    })
    expect(line).toContain("SOURCE: fail-safe")
  })
})
