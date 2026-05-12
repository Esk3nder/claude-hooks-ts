import { describe, expect, test } from "bun:test"
import { derivePatternKey } from "../../src/policies/permission-patterns.ts"

describe("derivePatternKey", () => {
  test("Bash keys are exact after normalization", () => {
    const a = derivePatternKey("Bash", { command: "git status -s" })
    const b = derivePatternKey("Bash", { command: "git status" })
    const c = derivePatternKey("Bash", { command: "  git   status ;;;" })
    expect(a).not.toBe(b)
    expect(b).toBe(c)
    expect(a).toMatch(/^Bash:exact:[a-f0-9]{16}$/)
  })

  test("Bash with different commands differs", () => {
    const a = derivePatternKey("Bash", { command: "git status" })
    const b = derivePatternKey("Bash", { command: "git push" })
    expect(a).not.toBe(b)
  })

  test("Edit keys are exact per path, not per extension", () => {
    const a = derivePatternKey("Edit", { file_path: "/repo/src/foo.ts" })
    const b = derivePatternKey("Edit", { file_path: "/repo/lib/bar.ts" })
    expect(a).not.toBe(b)
    expect(a).toMatch(/^Edit:path:[a-f0-9]{16}$/)
  })

  test("generic tool hashes serialized input", () => {
    const a = derivePatternKey("Custom", { kind: "x", n: 1 })
    expect(a).toMatch(/^Custom:exact:[a-f0-9]{16}$/)
  })

  test("Bash with malformed input is stable", () => {
    const a = derivePatternKey("Bash", null)
    const b = derivePatternKey("Bash", { not_command: 1 })
    expect(typeof a).toBe("string")
    expect(typeof b).toBe("string")
  })
})
