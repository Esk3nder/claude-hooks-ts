import { describe, expect, test } from "bun:test"
import {
  CRITERIA_HEADING_RE,
  CANONICAL_CRITERIA_HEADING,
  countCriteria,
  diagnoseCriteria,
  extractCriteriaSection,
  parseCriteriaList,
} from "../../../src/algorithm/isa/criteria.ts"

describe("CRITERIA_HEADING_RE — the classifier verbatim", () => {
  test("matches `## Criteria`", () => {
    expect(CRITERIA_HEADING_RE.test("## Criteria")).toBe(true)
  })
  test("matches `## ISC Criteria`", () => {
    expect(CRITERIA_HEADING_RE.test("## ISC Criteria")).toBe(true)
  })
  test("matches `## IDEAL STATE CRITERIA (Verification Criteria)`", () => {
    expect(
      CRITERIA_HEADING_RE.test(
        "## IDEAL STATE CRITERIA (Verification Criteria)",
      ),
    ).toBe(true)
  })
  test("matches `### Criteria` sub-heading (legacy)", () => {
    expect(CRITERIA_HEADING_RE.test("### Criteria")).toBe(true)
  })
  test("does NOT match `## Criterion` (similar but wrong)", () => {
    expect(CRITERIA_HEADING_RE.test("## Criterion")).toBe(false)
  })
  test("CANONICAL_CRITERIA_HEADING is `## ISC Criteria`", () => {
    expect(CANONICAL_CRITERIA_HEADING).toBe("## ISC Criteria")
  })
})

describe("extractCriteriaSection — the classifier mirror", () => {
  test("returns body up to next H2", () => {
    const doc = `## ISC Criteria
- [ ] ISC-1: a
- [x] ISC-2: b
## Decisions
junk
`
    const body = extractCriteriaSection(doc)
    expect(body).not.toBeNull()
    expect(body).toContain("ISC-1")
    expect(body).toContain("ISC-2")
    expect(body).not.toContain("Decisions")
    expect(body).not.toContain("junk")
  })

  test("returns body up to YAML doc terminator", () => {
    const doc = `## Criteria
- [ ] ISC-1: a
---
trailer
`
    expect(extractCriteriaSection(doc)).toContain("ISC-1")
    expect(extractCriteriaSection(doc)).not.toContain("trailer")
  })

  test("returns body to EOF when no terminator", () => {
    const doc = `## Criteria
- [ ] ISC-1: a
- [ ] ISC-2: b`
    expect(extractCriteriaSection(doc)).toContain("ISC-2")
  })

  test("returns null when no recognized heading", () => {
    expect(extractCriteriaSection("## Goals\n- [ ] x\n")).toBeNull()
  })

  test("does NOT terminate at H3 (only H2 ends the section)", () => {
    const doc = `## Criteria
- [ ] ISC-1: a
### Sub-heading
- [ ] ISC-2: still in criteria
`
    const body = extractCriteriaSection(doc)
    expect(body).toContain("ISC-2")
  })
})

describe("countCriteria — the classifier mirror", () => {
  test("counts checked vs total", () => {
    const doc = `## Criteria
- [ ] ISC-1: a
- [x] ISC-2: b
- [x] ISC-3: c
- [ ] ISC-4: d
`
    expect(countCriteria(doc)).toEqual({ checked: 2, total: 4 })
  })

  test("returns 0/0 when section missing", () => {
    expect(countCriteria("# no criteria here")).toEqual({
      checked: 0,
      total: 0,
    })
  })

  test("ignores non-checkbox lines inside criteria section", () => {
    const doc = `## Criteria
some prose
- [ ] ISC-1: a
- [x] ISC-2: b
more prose
`
    expect(countCriteria(doc)).toEqual({ checked: 1, total: 2 })
  })
})

describe("parseCriteriaList — the classifier mirror", () => {
  test("primary v5.5.0+ format with Anti: prefix", () => {
    const doc = `## Criteria
- [ ] ISC-1: build the thing
- [x] ISC-2: ship the thing
- [ ] ISC-3: Anti: never break the API
`
    const out = parseCriteriaList(doc)
    expect(out.length).toBe(3)
    expect(out[0]).toMatchObject({
      id: "ISC-1",
      type: "criterion",
      status: "pending",
    })
    expect(out[1]).toMatchObject({
      id: "ISC-2",
      type: "criterion",
      status: "completed",
    })
    expect(out[2]).toMatchObject({
      id: "ISC-3",
      type: "anti-criterion",
      status: "pending",
    })
  })

  test("backward-compat: pre-v5.3.0 bracketed category [F]", () => {
    const doc = `## Criteria
- [x] ISC-1 [F]: feature criterion
- [ ] ISC-2 [S]: structural criterion
`
    const out = parseCriteriaList(doc)
    expect(out[0]?.category).toBe("F")
    expect(out[1]?.category).toBe("S")
  })

  test("backward-compat: nested probe bracket [F][grep]", () => {
    const doc = `## Criteria
- [x] ISC-1 [F][grep]: feature with probe
`
    const out = parseCriteriaList(doc)
    expect(out[0]?.id).toBe("ISC-1")
    expect(out[0]?.category).toBe("F")
  })

  test("backward-compat: ISC-A-N numbering classifies as anti-criterion", () => {
    const doc = `## Criteria
- [ ] ISC-A-1: legacy anti
`
    const out = parseCriteriaList(doc)
    expect(out[0]?.type).toBe("anti-criterion")
  })

  test("loose fallback: no colon, with status bracket [COMPLETE] stripped", () => {
    const doc = `## Criteria
- [x] ISC-1 [COMPLETE] did the thing
`
    const out = parseCriteriaList(doc)
    expect(out.length).toBe(1)
    expect(out[0]?.id).toBe("ISC-1")
    expect(out[0]?.description).toBe("did the thing")
    // [COMPLETE] is NOT a real category — should be undefined
    expect(out[0]?.category).toBeUndefined()
  })

  test("status bracket [DONE] / [WIP] not captured as category", () => {
    const doc = `## Criteria
- [x] ISC-1 [DONE] one
- [ ] ISC-2 [WIP] two
`
    const out = parseCriteriaList(doc)
    expect(out[0]?.category).toBeUndefined()
    expect(out[1]?.category).toBeUndefined()
  })

  test("domain-prefixed IDs (ISC-CLI-3) NOT classified as anti-criterion", () => {
    const doc = `## Criteria
- [ ] ISC-CLI-3: CLI behavior criterion
`
    // this package's `id.includes('-A-')` would falsely match ISC-CLI-3 too — wait,
    // actually ISC-CLI-3 contains '-C-' not '-A-'. Domain prefix safe.
    // Test the safer case: a domain prefix that COULD include '-A-' would
    // match — that's a known parity limit. Test the common case.
    const out = parseCriteriaList(doc)
    expect(out[0]?.type).toBe("criterion")
  })

  test("returns [] when criteria section absent", () => {
    expect(parseCriteriaList("# no criteria")).toEqual([])
  })

  test("ignores prose lines inside criteria section", () => {
    const doc = `## Criteria
some prose
- [ ] ISC-1: real
not a checkbox
- [x] ISC-2: real2
`
    const out = parseCriteriaList(doc)
    expect(out.length).toBe(2)
  })
})

describe("diagnoseCriteria — the classifier mirror", () => {
  test("missing-section when no Criteria heading", () => {
    expect(diagnoseCriteria("# no criteria here")).toBe("missing-section")
  })

  test("empty-section when heading present, no checkboxes", () => {
    expect(diagnoseCriteria("## Criteria\n\nsome prose only\n")).toBe(
      "empty-section",
    )
  })

  test("all-dropped when checkboxes present but ALL fail to parse", () => {
    // Checkbox lines without an ISC- prefix → primary regex fails AND loose
    // fallback fails because there's no ISC ID.
    const doc = `## Criteria
- [ ] no isc id here
- [x] still no id
`
    expect(diagnoseCriteria(doc)).toBe("all-dropped")
  })

  test("null when at least one criterion parses", () => {
    expect(diagnoseCriteria("## Criteria\n- [ ] ISC-1: ok\n")).toBeNull()
  })
})
