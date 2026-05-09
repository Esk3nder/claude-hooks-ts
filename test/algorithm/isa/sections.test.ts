import { describe, expect, test } from "bun:test"
import {
  ISA_SECTIONS_V2_7,
  parseSections,
  presentSections,
} from "../../../src/algorithm/isa/sections.ts"

const FULL_ISA = `---
task: a
slug: x
phase: observe
---

# Title

## Problem
something is broken

## Vision
fixing it euphorically

## Out of Scope
not refactoring the whole thing

## Principles
substrate-independent

## Constraints
must be backward-compat

## Goal
ship the thing without breaking X

## Criteria
- [ ] ISC-1: thing works

## Test Strategy
isc-1 | bash | smoke | n/a | bash

## Features
feat-a | ISC-1 | none | yes

## Decisions
- 2026-05-09: chose A over B

## Changelog
conjectured: X
refuted by: Y
learned: Z
criterion now: W

## Verification
- ISC-1: bash test passes
`

describe("ISA_SECTIONS_V2_7 — IsaFormat.md lines 174-187 mirror", () => {
  test("has exactly 12 sections in fixed order", () => {
    expect(ISA_SECTIONS_V2_7.length).toBe(12)
    expect([...ISA_SECTIONS_V2_7]).toEqual([
      "Problem",
      "Vision",
      "Out of Scope",
      "Principles",
      "Constraints",
      "Goal",
      "Criteria",
      "Test Strategy",
      "Features",
      "Decisions",
      "Changelog",
      "Verification",
    ])
  })
})

describe("parseSections", () => {
  test("returns all 12 sections from a complete ISA", () => {
    const out = parseSections(FULL_ISA)
    expect(out.size).toBe(12)
    for (const name of ISA_SECTIONS_V2_7) {
      expect(out.has(name)).toBe(true)
    }
  })

  test("section bodies are trimmed of leading/trailing newlines", () => {
    const out = parseSections(FULL_ISA)
    expect(out.get("Goal")?.body).toBe("ship the thing without breaking X")
  })

  test("strips frontmatter before parsing", () => {
    // If frontmatter weren't stripped, the YAML `---` terminator could trip
    // section-end detection on the first H2.
    const out = parseSections(FULL_ISA)
    expect(out.get("Problem")?.body).toBe("something is broken")
  })

  test("missing sections are absent from the map (NOT present-with-empty)", () => {
    const partial = `## Problem\nx\n## Goal\ny\n## Criteria\n- [ ] ISC-1: a\n`
    const out = parseSections(partial)
    expect(out.size).toBe(3)
    expect(out.has("Vision")).toBe(false)
    expect(out.has("Decisions")).toBe(false)
  })

  test("Criteria heading variants — `## ISC Criteria` recognized", () => {
    const doc = `## ISC Criteria\n- [ ] ISC-1: x\n`
    expect(parseSections(doc).has("Criteria")).toBe(true)
  })

  test("Criteria heading variants — `## IDEAL STATE CRITERIA (...)` recognized", () => {
    const doc = `## IDEAL STATE CRITERIA (Verification Criteria)\n- [ ] ISC-1: x\n`
    expect(parseSections(doc).has("Criteria")).toBe(true)
  })

  test("section ends at next H2, not at H3", () => {
    const doc = `## Goal\nspine\n### sub\nstill in goal\n## Criteria\n- [ ] ISC-1: x\n`
    expect(parseSections(doc).get("Goal")?.body).toContain("still in goal")
  })

  test("trailing parenthesized qualifier on heading is allowed", () => {
    const doc = `## Out of Scope (anti-vision)\nnot doing X\n`
    const out = parseSections(doc)
    expect(out.has("Out of Scope")).toBe(true)
    expect(out.get("Out of Scope")?.rawHeading).toBe("## Out of Scope (anti-vision)")
  })

  test("case-insensitive on canonical name", () => {
    const doc = `## goal\nspine\n`
    expect(parseSections(doc).has("Goal")).toBe(true)
  })

  test("rawHeading preserves the original spacing", () => {
    const doc = `## Goal\nspine\n`
    expect(parseSections(doc).get("Goal")?.rawHeading).toBe("## Goal")
  })

  test("returns empty map on a fully empty ISA", () => {
    expect(parseSections("").size).toBe(0)
  })
})

describe("presentSections convenience", () => {
  test("returns just the names", () => {
    const partial = `## Problem\nx\n## Goal\ny\n`
    const set = presentSections(partial)
    expect(set.has("Problem")).toBe(true)
    expect(set.has("Goal")).toBe(true)
    expect(set.has("Vision")).toBe(false)
    expect(set.size).toBe(2)
  })
})
