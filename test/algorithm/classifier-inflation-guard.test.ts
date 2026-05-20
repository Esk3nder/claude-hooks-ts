import { describe, expect, test } from "bun:test"
import {
  checkStructuralEvidence,
  checkUnderClassification,
  hasStructuralSignal,
} from "../../src/algorithm/classifier-inflation-guard.ts"
import type { Mode, Tier } from "../../src/services/inference.ts"

describe("hasStructuralSignal", () => {
  test.each<[string, boolean, string]>([
    ["", false, "empty string"],
    ["thanks, that's great", false, "casual ack"],
    ["update the implementation", false, "verb but no structural cue"],
    ["fix it", false, "trivial directive"],
    ["here's some code:\n```ts\nconst x = 1\n```", true, "code fence"],
    ["touch src/a.ts and src/b.ts and src/c.ts", true, "≥3 file-extension paths"],
    ["change foo.ts and bar.ts only", false, "only 2 file paths"],
    ["look at src/foo and ./scripts/bar and lib/baz", true, "≥3 slash-paths"],
    ["needs a multi-step refactor", true, "structural verb 'multi-step'"],
    ["refactor the orchestration layer", true, "structural verb 'orchestration'"],
    ["cross-cutting doctrine change", true, "structural verb 'cross-cutting'"],
    ["see .claude-hooks/work/abc/ISA.md", true, "ISA reference"],
    ["The classifier biases up", false, "prose with no structural signal"],
    ["evaluate the trade-off and/or pivot", false, "common English slash idiom"],
    ["he/she/they prefer the new flow", false, "pronoun slash idiom"],
  ])("hasStructuralSignal(%p) → %p (%s)", (input, expected) => {
    expect(hasStructuralSignal(input)).toBe(expected)
  })
})

describe("checkStructuralEvidence — tiers 1-3 and null pass through", () => {
  test.each<[Tier | null, string]>([
    [null, "MINIMAL/NATIVE"],
    [1, "ALGORITHM E1"],
    [2, "ALGORITHM E2"],
    [3, "ALGORITHM E3"],
  ])(
    "tier %p passes through with no normalization (%s)",
    (tier, _label) => {
      const r = checkStructuralEvidence({
        prompt: "anything",
        tier,
      })
      expect(r.pass).toBe(true)
      expect(r.reason).toBe("tier < 4; no normalization")
    },
  )
})

describe("checkStructuralEvidence — tier 4+ floors without evidence", () => {
  test("E4 prompt with no structural signal → floored to E3", () => {
    const r = checkStructuralEvidence({
      prompt: "do it carefully",
      tier: 4,
    })
    expect(r.pass).toBe(false)
    expect(r.floorTier).toBe(3)
    expect(r.reason).toContain("tier 4 floored to 3")
  })

  test("E5 prompt with no structural signal → floored to E3", () => {
    const r = checkStructuralEvidence({
      prompt: "make this great",
      tier: 5,
    })
    expect(r.pass).toBe(false)
    expect(r.floorTier).toBe(3)
    expect(r.reason).toContain("tier 5 floored to 3")
  })

  test("E4 prompt with no signal AND empty context → floored to E3", () => {
    const r = checkStructuralEvidence({
      prompt: "ship it",
      context: "",
      tier: 4,
    })
    expect(r.pass).toBe(false)
    expect(r.floorTier).toBe(3)
  })
})

describe("checkStructuralEvidence — tier 4+ kept with evidence", () => {
  test("E4 prompt with code fence in prompt → kept E4", () => {
    const r = checkStructuralEvidence({
      prompt: "rewrite this:\n```ts\nexport const x = 1\n```",
      tier: 4,
    })
    expect(r.pass).toBe(true)
    expect(r.floorTier).toBe(4)
    expect(r.reason).toBe("structural signal in prompt")
  })

  test("E4 short prompt with ≥3 file refs in context → kept E4", () => {
    const r = checkStructuralEvidence({
      prompt: "ok proceed",
      context: "touch src/foo.ts, src/bar.ts, src/baz.ts in the next pass",
      tier: 4,
    })
    expect(r.pass).toBe(true)
    expect(r.floorTier).toBe(4)
    expect(r.reason).toBe("structural signal in recent context")
  })

  test("E5 prompt with structural verb 'architecture' → kept E5", () => {
    const r = checkStructuralEvidence({
      prompt: "revisit the architecture of the worker layer",
      tier: 5,
    })
    expect(r.pass).toBe(true)
    expect(r.floorTier).toBe(5)
  })

  test("E4 prompt referencing an active ISA → kept E4", () => {
    const r = checkStructuralEvidence({
      prompt: "continue per .claude-hooks/work/abc/ISA.md",
      tier: 4,
    })
    expect(r.pass).toBe(true)
    expect(r.floorTier).toBe(4)
  })
})

describe("checkStructuralEvidence — prompt-OR-context evidence", () => {
  test("evidence in prompt takes precedence", () => {
    const r = checkStructuralEvidence({
      prompt: "multi-step migration",
      context: "boring prose",
      tier: 4,
    })
    expect(r.pass).toBe(true)
    expect(r.reason).toBe("structural signal in prompt")
  })

  test("evidence in context alone is sufficient", () => {
    const r = checkStructuralEvidence({
      prompt: "yes",
      context: "we agreed on a cross-cutting refactor across these files",
      tier: 4,
    })
    expect(r.pass).toBe(true)
    expect(r.reason).toBe("structural signal in recent context")
  })

  test("neither side has evidence → floor", () => {
    const r = checkStructuralEvidence({
      prompt: "yes",
      context: "thanks, that worked",
      tier: 4,
    })
    expect(r.pass).toBe(false)
    expect(r.floorTier).toBe(3)
  })
})

// ──────────────────────────────────────────────────────────────────────
// US-3c — Deflation guard (symmetric to checkStructuralEvidence)
// ──────────────────────────────────────────────────────────────────────

describe("checkUnderClassification — short-circuits (no escalation)", () => {
  test.each<[Mode, Tier | null]>([
    ["ALGORITHM", 1],
    ["ALGORITHM", 2],
    ["ALGORITHM", 3],
    ["ALGORITHM", 4],
    ["ALGORITHM", 5],
  ])("ALGORITHM mode at any tier → pass (never escalates an already-engaged classification)", (mode, tier) => {
    const r = checkUnderClassification({
      prompt: "touch src/a.ts and src/b.ts and src/c.ts",
      mode,
      tier,
    })
    expect(r.pass).toBe(true)
  })

  test("MINIMAL with no structural signal → pass (true negative)", () => {
    const r = checkUnderClassification({
      prompt: "thanks",
      mode: "MINIMAL",
      tier: null,
    })
    expect(r.pass).toBe(true)
  })

  test("NATIVE with no structural signal → pass (true negative)", () => {
    const r = checkUnderClassification({
      prompt: "what time is it",
      mode: "NATIVE",
      tier: null,
    })
    expect(r.pass).toBe(true)
  })

  test("empty prompt with no context → pass", () => {
    const r = checkUnderClassification({
      prompt: "",
      mode: "MINIMAL",
      tier: null,
    })
    expect(r.pass).toBe(true)
  })
})

describe("checkUnderClassification — escalation on structural evidence", () => {
  test("MINIMAL + prompt naming ≥3 src files → escalates to ALGORITHM E1", () => {
    // A single file path is NOT a structural signal — "fix the typo on
    // foo.ts" is canonically NATIVE per the rubric and the guard
    // correctly leaves it alone. The deflation guard fires on the same
    // signal set US-3 uses, which requires ≥3 file paths.
    const r = checkUnderClassification({
      prompt: "fix typos in src/foo.ts, src/bar.ts, and src/baz.ts",
      mode: "MINIMAL",
      tier: null,
    })
    expect(r.pass).toBe(false)
    expect(r.floorMode).toBe("ALGORITHM")
    expect(r.floorTier).toBe(1)
    expect(r.reason).toContain("deflation-guard")
  })

  test("MINIMAL + single file path → pass (canonical NATIVE case, no escalation)", () => {
    // Documenting the asymmetry: the classifier should pick NATIVE here.
    // If it picked MINIMAL by mistake, the deflation guard still
    // declines to escalate — a single file edit is not strong enough
    // structural evidence to warrant engagement ceremony.
    const r = checkUnderClassification({
      prompt: "fix the typo on src/foo.ts",
      mode: "MINIMAL",
      tier: null,
    })
    expect(r.pass).toBe(true)
  })

  test("NATIVE + prompt with code fence → escalates to ALGORITHM E1", () => {
    const r = checkUnderClassification({
      prompt: "rewrite this\n```ts\nconst x = 1\n```",
      mode: "NATIVE",
      tier: null,
    })
    expect(r.pass).toBe(false)
    expect(r.floorMode).toBe("ALGORITHM")
    expect(r.floorTier).toBe(1)
  })

  test("MINIMAL ack + recent context with code block → escalates (praise-after-code case)", () => {
    const r = checkUnderClassification({
      prompt: "thanks",
      context: "look at this:\n```ts\nfunction foo() {}\n```",
      mode: "MINIMAL",
      tier: null,
    })
    expect(r.pass).toBe(false)
    expect(r.floorMode).toBe("ALGORITHM")
    expect(r.floorTier).toBe(1)
  })

  test("NATIVE + structural verb 'cross-cutting' → escalates", () => {
    const r = checkUnderClassification({
      prompt: "do the cross-cutting refactor",
      mode: "NATIVE",
      tier: null,
    })
    expect(r.pass).toBe(false)
    expect(r.floorTier).toBe(1)
  })

  test("never escalates above tier 1", () => {
    // A very rich prompt — code fence, file paths, structural verb.
    // Floor tier is still 1, never 2 or 3.
    const r = checkUnderClassification({
      prompt:
        "multi-step refactor:\n```ts\nfn()\n```\nin src/a.ts, src/b.ts, src/c.ts",
      mode: "MINIMAL",
      tier: null,
    })
    expect(r.pass).toBe(false)
    expect(r.floorMode).toBe("ALGORITHM")
    expect(r.floorTier).toBe(1)
  })
})

describe("checkUnderClassification — symmetry with checkStructuralEvidence", () => {
  test("inflation and deflation guards share the same signal definition", () => {
    const evidencePrompt = "look at src/foo.ts and src/bar.ts and src/baz.ts"
    expect(hasStructuralSignal(evidencePrompt)).toBe(true)
    // Inflation guard keeps an evidence-bearing E5
    const infl = checkStructuralEvidence({ prompt: evidencePrompt, tier: 5 })
    expect(infl.pass).toBe(true)
    expect(infl.floorTier).toBe(5)
    // Deflation guard escalates the same prompt out of MINIMAL
    const defl = checkUnderClassification({
      prompt: evidencePrompt,
      mode: "MINIMAL",
      tier: null,
    })
    expect(defl.pass).toBe(false)
    expect(defl.floorTier).toBe(1)
  })
})
