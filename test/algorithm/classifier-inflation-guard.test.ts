import { describe, expect, test } from "bun:test"
import {
  checkStructuralEvidence,
  hasStructuralSignal,
} from "../../src/algorithm/classifier-inflation-guard.ts"
import type { Tier } from "../../src/services/inference.ts"

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
