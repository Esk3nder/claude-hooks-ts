import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import {
  expandPathMatchCandidates,
  normalizePath,
  normalizePathPattern,
} from "../../src/policies/path-utils.ts"

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

describe("normalizePathPattern", () => {
  test("normalizes ./-prefixed repo-local glob patterns", () => {
    expect(normalizePathPattern("./src/*.ts")).toBe("src/*.ts")
  })
})

describe("expandPathMatchCandidates", () => {
  test("absolute changed paths also produce repo-relative candidates", () => {
    expect(expandPathMatchCandidates("/repo", ["/repo/src/a.ts"])).toEqual([
      "/repo/src/a.ts",
      "src/a.ts",
    ])
  })

  test("relative changed paths also preserve absolute-policy compatibility", () => {
    expect(expandPathMatchCandidates("/repo", ["./src/a.ts"])).toEqual([
      "src/a.ts",
      "/repo/src/a.ts",
    ])
  })

  test("absolute paths outside the root are not rewritten as parent-relative globs", () => {
    expect(expandPathMatchCandidates("/repo", ["/other/src/a.ts"])).toEqual([
      "/other/src/a.ts",
    ])
  })
})
