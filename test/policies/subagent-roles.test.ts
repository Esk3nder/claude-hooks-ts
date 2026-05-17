import { describe, expect, test } from "bun:test"
import { lookupRole, hasEvidence } from "../../src/policies/subagent-roles.ts"

describe("lookupRole", () => {
  test("Explore is read-only and investigative", () => {
    const r = lookupRole("Explore")
    expect(r.mode).toBe("read-only")
    expect(r.investigative).toBe(true)
    expect(r.scopeRule).toContain("read-only investigator")
    expect(r.outputContract).toContain("evidence anchors")
    expect(r.outputContract).toContain("markdown directly")
    expect(r.outputContract).toContain("do not wrap it in JSON")
  })

  test("general-purpose is write-allowed and not investigative", () => {
    const r = lookupRole("general-purpose")
    expect(r.mode).toBe("write-allowed")
    expect(r.investigative).toBe(false)
  })

  test("unknown subagent returns default rule", () => {
    const r = lookupRole("nonexistent-role")
    expect(r.mode).toBe("unknown")
    expect(r.investigative).toBe(false)
  })

  test("undefined subagent returns default rule", () => {
    const r = lookupRole(undefined)
    expect(r.mode).toBe("unknown")
  })
})

describe("hasEvidence", () => {
  test("path:line plus confidence counts as evidence", () => {
    expect(hasEvidence("see src/foo.ts:42 for the bug — confidence: high")).toBe(true)
  })

  test("command plus next action counts as evidence", () => {
    expect(hasEvidence("ran $ bun test. Next: fix src/foo.ts:42")).toBe(true)
  })

  test("bare file path does not satisfy the evidence contract", () => {
    expect(hasEvidence("see README.md")).toBe(false)
  })

  test("plain summary without evidence returns false", () => {
    expect(hasEvidence("ok done")).toBe(false)
  })

  test("empty / undefined returns false", () => {
    expect(hasEvidence(undefined)).toBe(false)
    expect(hasEvidence("")).toBe(false)
    expect(hasEvidence("   ")).toBe(false)
  })

  test("confidence marker alone is not enough", () => {
    expect(hasEvidence("findings: ... confidence: high")).toBe(false)
  })

  test("anchor plus casual 'next' as time-adverb does not count as judgment", () => {
    expect(
      hasEvidence("see src/foo.ts:42 the next morning we will look again"),
    ).toBe(false)
  })

  test("anchor plus 'risky' word fragment alone does not count as judgment", () => {
    expect(hasEvidence("see src/foo.ts:42, briskly noted")).toBe(false)
  })

  test("confidence with no real value (just punctuation) does not count", () => {
    expect(hasEvidence("ran $ bun test. confidence: -")).toBe(false)
  })

  test("confidence with a known value counts as judgment", () => {
    expect(hasEvidence("ran $ bun test. confidence: high")).toBe(true)
  })

  test("'next steps' counts as judgment", () => {
    expect(hasEvidence("see src/foo.ts:42. Next steps: refactor")).toBe(true)
  })

  test("'next action' counts as judgment", () => {
    expect(hasEvidence("see src/foo.ts:42. next action: write a test")).toBe(true)
  })

  test("judgment-only mode: planner output without anchors passes when it has judgment", () => {
    expect(
      hasEvidence(
        "Recommendation: split auth into AuthN and AuthZ. Risk: session migration. Confidence: medium",
        { judgmentOnly: true },
      ),
    ).toBe(true)
  })

  test("judgment-only mode: empty / blank still fails", () => {
    expect(hasEvidence("ok", { judgmentOnly: true })).toBe(false)
    expect(hasEvidence("", { judgmentOnly: true })).toBe(false)
  })
})

describe("planner / architect — judgment-only investigative roles", () => {
  test("Plan role is investigative but judgment-only", () => {
    const r = lookupRole("Plan")
    expect(r.investigative).toBe(true)
    expect(r.judgmentOnly).toBe(true)
  })

  test("planner role is investigative but judgment-only", () => {
    const r = lookupRole("planner")
    expect(r.investigative).toBe(true)
    expect(r.judgmentOnly).toBe(true)
  })

  test("architect role is investigative but judgment-only", () => {
    const r = lookupRole("architect")
    expect(r.investigative).toBe(true)
    expect(r.judgmentOnly).toBe(true)
  })

  test("Explore role is investigative and requires anchor (not judgment-only)", () => {
    const r = lookupRole("Explore")
    expect(r.investigative).toBe(true)
    expect(r.judgmentOnly).toBeFalsy()
  })
})
