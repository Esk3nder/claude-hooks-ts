import { describe, expect, test } from "bun:test"
import {
  expectedIsaPathFor,
  normalizeExpectedIsaPath,
} from "../../../src/algorithm/isa/tier-policy.ts"

describe("ISA tier policy path contract", () => {
  test("expectedIsaPathFor sanitizes session ids before building a path", () => {
    const path = expectedIsaPathFor("../escape/session")
    expect(path).toStartWith(".claude-hooks/work/")
    expect(path).toEndWith("/ISA.md")
    expect(path).not.toContain("../")
  })

  test("normalizeExpectedIsaPath accepts only scoped task ISA paths", () => {
    expect(normalizeExpectedIsaPath("./.claude-hooks/work/sess-1/ISA.md")).toBe(
      ".claude-hooks/work/sess-1/ISA.md",
    )
    expect(normalizeExpectedIsaPath(".claude-hooks/work/../escape/ISA.md")).toBeNull()
    expect(normalizeExpectedIsaPath(".claude-hooks/work/bad slug/ISA.md")).toBeNull()
    expect(normalizeExpectedIsaPath(".claude-hooks/work/bad\nslug/ISA.md")).toBeNull()
    expect(normalizeExpectedIsaPath("ISA.md")).toBeNull()
  })
})
