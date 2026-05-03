import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { normalizePath } from "../../src/policies/path-utils.ts"

describe("normalizePath — ~ expansion via os.homedir() (M9 fix #4)", () => {
  test("'~/.env' expands to '<homedir>/.env'", () => {
    const out = normalizePath("~/.env")
    const expected = (homedir() + "/.env").replace(/\\/g, "/").replace(/\/+/g, "/")
    expect(out).toBe(expected)
  })

  test("'~' alone expands to homedir", () => {
    const out = normalizePath("~")
    const expected = (homedir() || "~").replace(/\\/g, "/").replace(/\/+/g, "/")
    expect(out).toBe(expected)
  })

  test("non-tilde paths are unchanged (modulo slash normalization)", () => {
    expect(normalizePath("/etc/passwd")).toBe("/etc/passwd")
    expect(normalizePath("/a//b///c")).toBe("/a/b/c")
  })
})
