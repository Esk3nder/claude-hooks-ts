import { describe, expect, test } from "bun:test"
import {
  parseFrontmatter,
  writeFrontmatterField,
} from "../../../src/algorithm/isa/frontmatter.ts"

const FIXTURE = `---
task: ship the auth refactor
slug: 20260509-100000_ship-auth
effort: advanced
phase: observe
progress: 0/8
mode: interactive
started: 2026-05-09T10:00:00Z
updated: 2026-05-09T10:00:00Z
---

# title

body
`

describe("parseFrontmatter — PAI line 70-80 mirror", () => {
  test("extracts all 8 required fields", () => {
    const fm = parseFrontmatter(FIXTURE)
    expect(fm).not.toBeNull()
    expect(fm?.["task"]).toBe("ship the auth refactor")
    expect(fm?.["slug"]).toBe("20260509-100000_ship-auth")
    expect(fm?.["effort"]).toBe("advanced")
    expect(fm?.["phase"]).toBe("observe")
    expect(fm?.["progress"]).toBe("0/8")
    expect(fm?.["mode"]).toBe("interactive")
    expect(fm?.["started"]).toBe("2026-05-09T10:00:00Z")
    expect(fm?.["updated"]).toBe("2026-05-09T10:00:00Z")
  })

  test("returns null when no frontmatter block", () => {
    expect(parseFrontmatter("# just a body\nno fm")).toBeNull()
  })

  test("strips surrounding double quotes (PAI quirk)", () => {
    const fm = parseFrontmatter(`---\ntask: "quoted task"\n---\n`)
    expect(fm?.["task"]).toBe("quoted task")
  })

  test("strips surrounding single quotes (PAI quirk)", () => {
    const fm = parseFrontmatter(`---\ntask: 'quoted task'\n---\n`)
    expect(fm?.["task"]).toBe("quoted task")
  })

  test("ignores lines without a colon", () => {
    const fm = parseFrontmatter(`---\ntask: x\nnocolon\nslug: y\n---\n`)
    expect(fm?.["task"]).toBe("x")
    expect(fm?.["slug"]).toBe("y")
    expect("nocolon" in (fm ?? {})).toBe(false)
  })

  test("colon at index 0 (no key) is ignored", () => {
    const fm = parseFrontmatter(`---\n: nokey\ntask: x\n---\n`)
    expect(fm?.["task"]).toBe("x")
    expect(Object.keys(fm ?? {}).length).toBe(1)
  })

  test("only the FIRST frontmatter block is read (PAI behavior)", () => {
    const doc = `---
task: first
---
body
---
task: second
---`
    const fm = parseFrontmatter(doc)
    expect(fm?.["task"]).toBe("first")
  })
})

describe("writeFrontmatterField — PAI line 81-93 mirror", () => {
  test("updates an existing field in place", () => {
    const out = writeFrontmatterField(FIXTURE, "phase", "build")
    const fm = parseFrontmatter(out)
    expect(fm?.["phase"]).toBe("build")
    // Other fields preserved
    expect(fm?.["task"]).toBe("ship the auth refactor")
  })

  test("appends a missing field to the end of the frontmatter block", () => {
    const out = writeFrontmatterField(FIXTURE, "iteration", "2")
    const fm = parseFrontmatter(out)
    expect(fm?.["iteration"]).toBe("2")
    // Body preserved
    expect(out).toContain("# title")
  })

  test("returns input unchanged when there is no frontmatter", () => {
    const input = "# no fm\nbody"
    expect(writeFrontmatterField(input, "task", "x")).toBe(input)
  })

  test("preserves YAML doc terminator format", () => {
    const out = writeFrontmatterField(FIXTURE, "phase", "build")
    expect(out).toContain("\n---\n")
  })

  test("handles fields with empty initial value", () => {
    const input = `---\nfoo:\nbar: y\n---\n`
    const out = writeFrontmatterField(input, "foo", "filled")
    expect(parseFrontmatter(out)?.["foo"]).toBe("filled")
  })
})
