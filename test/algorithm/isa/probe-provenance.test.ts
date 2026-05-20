/**
 * US-14 — ISC checkbox probe-provenance.
 *
 * Pure-decision tests for:
 *   - parseProbeRequirements: extracts `requires_probe` column from the
 *     ISA `## Test Strategy` table
 *   - evaluateProbeProvenance: given criteria, requirements, and the
 *     session's probe_verified_iscs list, returns the list of completed
 *     ISCs that were checked WITHOUT probe provenance (caller blocks Stop)
 */
import { describe, expect, test } from "bun:test"
import {
  parseProbeRequirements,
  evaluateProbeProvenance,
} from "../../../src/algorithm/isa/probe-provenance.ts"
import type { CriterionEntry } from "../../../src/algorithm/isa/criteria.ts"

const c = (
  id: string,
  status: "pending" | "completed",
): CriterionEntry => ({
  id,
  description: id,
  type: "criterion",
  status,
})

// ──────────────────────────────────────────────────────────────────────
// parseProbeRequirements
// ──────────────────────────────────────────────────────────────────────

describe("parseProbeRequirements — requires_probe column extraction", () => {
  test("table with requires_probe column → boolean per ISC", () => {
    const body = `
| isc | type | check | threshold | tool | requires_probe |
|---|---|---|---|---|---|
| ISC-1 | unit | x | n/a | typecheck | true |
| ISC-2 | unit | y | n/a | tests | false |
| ISC-3 | unit | z | n/a | lint | true |
`.trim()
    const m = parseProbeRequirements(body)
    expect(m.get("ISC-1")).toBe(true)
    expect(m.get("ISC-2")).toBe(false)
    expect(m.get("ISC-3")).toBe(true)
  })

  test("table WITHOUT requires_probe column → empty map (back-compat)", () => {
    const body = `
| isc | tool |
|---|---|
| ISC-1 | typecheck |
| ISC-2 | tests |
`.trim()
    const m = parseProbeRequirements(body)
    expect(m.size).toBe(0)
  })

  test("malformed/missing cells → defaults to false (entry omitted)", () => {
    const body = `
| isc | tool | requires_probe |
|---|---|---|
| ISC-1 | typecheck | true |
| ISC-2 | tests |  |
| ISC-3 | lint | not-a-bool |
`.trim()
    const m = parseProbeRequirements(body)
    expect(m.get("ISC-1")).toBe(true)
    expect(m.has("ISC-2")).toBe(false)
    expect(m.has("ISC-3")).toBe(false)
  })

  test("accepts yes / no / 1 / 0 as boolean tokens", () => {
    const body = `
| isc | tool | requires_probe |
|---|---|---|
| ISC-1 | typecheck | yes |
| ISC-2 | tests | no |
| ISC-3 | lint | 1 |
| ISC-4 | build | 0 |
`.trim()
    const m = parseProbeRequirements(body)
    expect(m.get("ISC-1")).toBe(true)
    expect(m.get("ISC-2")).toBe(false)
    expect(m.get("ISC-3")).toBe(true)
    expect(m.get("ISC-4")).toBe(false)
  })

  test("empty body → empty map", () => {
    expect(parseProbeRequirements("").size).toBe(0)
    expect(parseProbeRequirements("\n\n").size).toBe(0)
  })

  test("non-table content → empty map", () => {
    const body = "Test strategy: run typecheck and tests for every ISC."
    expect(parseProbeRequirements(body).size).toBe(0)
  })
})

// ──────────────────────────────────────────────────────────────────────
// evaluateProbeProvenance
// ──────────────────────────────────────────────────────────────────────

describe("evaluateProbeProvenance — block when requires_probe ISCs lack provenance", () => {
  test("no requires_probe entries → passthrough", () => {
    const v = evaluateProbeProvenance({
      criteria: [c("ISC-1", "completed"), c("ISC-2", "completed")],
      requirements: new Map(),
      verifiedIscs: [],
    })
    expect(v.kind).toBe("passthrough")
  })

  test("requires_probe=true ISC + completed + provenance present → passthrough", () => {
    const v = evaluateProbeProvenance({
      criteria: [c("ISC-1", "completed")],
      requirements: new Map([["ISC-1", true]]),
      verifiedIscs: ["ISC-1"],
    })
    expect(v.kind).toBe("passthrough")
  })

  test("requires_probe=true ISC + completed + NO provenance → block", () => {
    const v = evaluateProbeProvenance({
      criteria: [c("ISC-1", "completed")],
      requirements: new Map([["ISC-1", true]]),
      verifiedIscs: [],
    })
    expect(v.kind).toBe("block")
    if (v.kind === "block") {
      expect(v.reason).toContain("ISC-1")
      expect(v.reason).toContain("requires_probe")
      expect(v.unverified).toContain("ISC-1")
    }
  })

  test("requires_probe=true ISC + STILL PENDING → passthrough (the other gate catches it)", () => {
    // A pending ISC is already blocked by the unchecked-ISC gate; this
    // gate doesn't double-block.
    const v = evaluateProbeProvenance({
      criteria: [c("ISC-1", "pending")],
      requirements: new Map([["ISC-1", true]]),
      verifiedIscs: [],
    })
    expect(v.kind).toBe("passthrough")
  })

  test("requires_probe=false → provenance not required even when completed", () => {
    const v = evaluateProbeProvenance({
      criteria: [c("ISC-1", "completed")],
      requirements: new Map([["ISC-1", false]]),
      verifiedIscs: [],
    })
    expect(v.kind).toBe("passthrough")
  })

  test("mixed: some require provenance and have it, others don't require → passthrough", () => {
    const v = evaluateProbeProvenance({
      criteria: [
        c("ISC-1", "completed"),
        c("ISC-2", "completed"),
        c("ISC-3", "completed"),
      ],
      requirements: new Map([
        ["ISC-1", true],
        ["ISC-2", false],
      ]),
      verifiedIscs: ["ISC-1"],
    })
    expect(v.kind).toBe("passthrough")
  })

  test("multiple unverified → block reason lists all of them", () => {
    const v = evaluateProbeProvenance({
      criteria: [
        c("ISC-1", "completed"),
        c("ISC-2", "completed"),
        c("ISC-3", "completed"),
      ],
      requirements: new Map([
        ["ISC-1", true],
        ["ISC-2", true],
        ["ISC-3", true],
      ]),
      verifiedIscs: ["ISC-2"],
    })
    expect(v.kind).toBe("block")
    if (v.kind === "block") {
      expect(v.unverified).toEqual(["ISC-1", "ISC-3"])
      expect(v.reason).toContain("ISC-1")
      expect(v.reason).toContain("ISC-3")
      expect(v.reason).not.toMatch(/\bISC-2\b/)
    }
  })

  test("verifiedIscs containing unknown ids → ignored gracefully (no error)", () => {
    const v = evaluateProbeProvenance({
      criteria: [c("ISC-1", "completed")],
      requirements: new Map([["ISC-1", true]]),
      verifiedIscs: ["ISC-1", "ISC-99-stale"],
    })
    expect(v.kind).toBe("passthrough")
  })
})
