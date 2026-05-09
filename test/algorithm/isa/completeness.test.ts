import { describe, expect, test } from "bun:test"
import {
  REQUIRED_SECTIONS_BY_TIER,
  checkCompleteness,
} from "../../../src/algorithm/isa/completeness.ts"

const E1_BARE = `## Goal\nx\n## Criteria\n- [ ] ISC-1: a\n`

const E2_BARE = `## Problem\nx\n## Goal\ny\n## Criteria\n- [ ] ISC-1: a\n## Test Strategy\nplan\n`

const E3_BARE = `## Problem\nx
## Vision\ny
## Out of Scope\nz
## Constraints\nq
## Goal\nspine
## Criteria
- [ ] ISC-1: a
## Test Strategy
plan
## Features
list
`

const E4_FULL = `## Problem\nx
## Vision\ny
## Out of Scope\nz
## Principles\np
## Constraints\nq
## Goal\nspine
## Criteria
- [ ] ISC-1: a
## Test Strategy
plan
## Features
list
## Decisions
- d
## Changelog
- c
## Verification
- v
`

describe("REQUIRED_SECTIONS_BY_TIER — IsaFormat.md lines 191-201 mirror", () => {
  test("E1 = Goal, Criteria", () => {
    expect(REQUIRED_SECTIONS_BY_TIER.get(1)).toEqual(["Goal", "Criteria"])
  })
  test("E2 = Problem, Goal, Criteria, Test Strategy", () => {
    expect(REQUIRED_SECTIONS_BY_TIER.get(2)).toEqual([
      "Problem",
      "Goal",
      "Criteria",
      "Test Strategy",
    ])
  })
  test("E3 = 8 sections", () => {
    expect(REQUIRED_SECTIONS_BY_TIER.get(3)?.length).toBe(8)
    expect(REQUIRED_SECTIONS_BY_TIER.get(3)).toContain("Vision")
    expect(REQUIRED_SECTIONS_BY_TIER.get(3)).toContain("Out of Scope")
    expect(REQUIRED_SECTIONS_BY_TIER.get(3)).toContain("Features")
  })
  test("E4 = all 12", () => {
    expect(REQUIRED_SECTIONS_BY_TIER.get(4)?.length).toBe(12)
  })
  test("E5 = all 12 (Interview run is reported but not in this list)", () => {
    expect(REQUIRED_SECTIONS_BY_TIER.get(5)?.length).toBe(12)
  })
})

describe("checkCompleteness — gate behavior", () => {
  test("E1 ok with just Goal+Criteria", () => {
    const r = checkCompleteness(E1_BARE, 1)
    expect(r.ok).toBe(true)
    expect(r.missing.length).toBe(0)
    expect(r.tier).toBe(1)
    expect(r.interviewRequired).toBe(false)
  })

  test("E1 missing Goal → not ok", () => {
    const r = checkCompleteness("## Criteria\n- [ ] ISC-1: a\n", 1)
    expect(r.ok).toBe(false)
    expect(r.missing).toContain("Goal")
  })

  test("E2 ok with Problem+Goal+Criteria+Test Strategy", () => {
    const r = checkCompleteness(E2_BARE, 2)
    expect(r.ok).toBe(true)
  })

  test("E2 missing Test Strategy → not ok", () => {
    const r = checkCompleteness(
      `## Problem\nx\n## Goal\ny\n## Criteria\n- [ ] ISC-1: a\n`,
      2,
    )
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual(["Test Strategy"])
  })

  test("E3 ok with 8 required sections", () => {
    const r = checkCompleteness(E3_BARE, 3)
    expect(r.ok).toBe(true)
  })

  test("E4 needs all 12; E3 input is not enough", () => {
    const r = checkCompleteness(E3_BARE, 4)
    expect(r.ok).toBe(false)
    expect(r.missing).toContain("Decisions")
    expect(r.missing).toContain("Changelog")
    expect(r.missing).toContain("Verification")
    expect(r.missing).toContain("Principles")
  })

  test("E4 ok with all 12", () => {
    const r = checkCompleteness(E4_FULL, 4)
    expect(r.ok).toBe(true)
    expect(r.interviewRequired).toBe(false)
  })

  test("E5 ok with all 12 BUT interviewRequired flag set", () => {
    const r = checkCompleteness(E4_FULL, 5)
    expect(r.ok).toBe(true)
    expect(r.interviewRequired).toBe(true)
  })

  test("project-ISA override floors tier to 3 (E1 → E3)", () => {
    const r = checkCompleteness(E1_BARE, 1, { isProjectIsa: true })
    expect(r.tier).toBe(3) // floored
    expect(r.ok).toBe(false) // E1 fixture lacks E3 sections
    expect(r.missing).toContain("Vision")
  })

  test("project-ISA override does NOT downgrade higher tiers (E5 stays E5)", () => {
    const r = checkCompleteness(E4_FULL, 5, { isProjectIsa: true })
    expect(r.tier).toBe(5)
    expect(r.interviewRequired).toBe(true)
  })

  test("present list reports what's there, not just what's missing", () => {
    const r = checkCompleteness(E2_BARE, 2)
    expect(r.present).toContain("Problem")
    expect(r.present).toContain("Goal")
    expect(r.present).toContain("Criteria")
    expect(r.present).toContain("Test Strategy")
  })
})
