import { describe, expect, test } from "bun:test"
import { evaluateProtectedPath } from "../../src/policies/protected-paths.ts"

describe("evaluateProtectedPath", () => {
  test("ask: /etc/hosts", () => {
    expect(evaluateProtectedPath("/etc/hosts").kind).toBe("ask")
  })
  test("ask: .git/config", () => {
    expect(evaluateProtectedPath("/repo/.git/config").kind).toBe("ask")
  })
  test("ask: github workflow", () => {
    expect(evaluateProtectedPath("/repo/.github/workflows/ci.yml").kind).toBe("ask")
  })
  test("ask: Dockerfile", () => {
    expect(evaluateProtectedPath("/repo/Dockerfile").kind).toBe("ask")
  })
  test("passthrough: src file", () => {
    expect(evaluateProtectedPath("/repo/src/foo.ts").kind).toBe("passthrough")
  })
})
