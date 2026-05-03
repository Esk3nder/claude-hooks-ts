import { describe, expect, test } from "bun:test"
import { derivePatternKey } from "../../src/policies/permission-patterns.ts"

describe("derivePatternKey", () => {
  test("Bash buckets by first two tokens", () => {
    const a = derivePatternKey("Bash", { command: "git status -s" })
    const b = derivePatternKey("Bash", { command: "git status" })
    expect(a).toBe(b)
    expect(a).toContain("git status")
  })

  test("Bash with different commands differs", () => {
    const a = derivePatternKey("Bash", { command: "git status" })
    const b = derivePatternKey("Bash", { command: "git push" })
    expect(a).not.toBe(b)
  })

  test("Edit buckets by extension", () => {
    const a = derivePatternKey("Edit", { file_path: "/repo/src/foo.ts" })
    const b = derivePatternKey("Edit", { file_path: "/repo/lib/bar.ts" })
    expect(a).toBe(b)
    expect(a).toContain(".ts")
  })

  test("generic tool serializes input", () => {
    const a = derivePatternKey("Custom", { kind: "x", n: 1 })
    expect(a.startsWith("Custom:")).toBe(true)
  })

  test("Bash with malformed input is stable", () => {
    const a = derivePatternKey("Bash", null)
    const b = derivePatternKey("Bash", { not_command: 1 })
    expect(typeof a).toBe("string")
    expect(typeof b).toBe("string")
  })
})
