import { describe, expect, test } from "bun:test"
import { lookupRole, hasEvidence } from "../../src/policies/subagent-roles.ts"

describe("lookupRole", () => {
  test("Explore is read-only and investigative", () => {
    const r = lookupRole("Explore")
    expect(r.mode).toBe("read-only")
    expect(r.investigative).toBe(true)
    expect(r.scopeRule).toContain("read-only investigator")
    expect(r.outputContract).toContain("evidence anchors")
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
})
