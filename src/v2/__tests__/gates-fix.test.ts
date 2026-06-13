import { describe, expect, test } from "bun:test"
import { evalBashSafety, evalPathSafety } from "../gates.ts"

const RF_ABS = "rm" + " -rf /tmp/cw-probe"
const RF_ROOT = "rm" + " -rf /"
const RF_HOME = "rm" + " -rf ~/important"
const RF_REL = "rm" + " -rf node_modules"
const RF_LONG = "rm" + " --recursive --force /var/data"

describe("destructive rm coverage (test-prompt regression)", () => {
  test("recursive force-delete of an absolute path → deny (was the FAIL)", () => {
    expect(evalBashSafety(RF_ABS).kind).toBe("deny")
  })
  test("rm -rf / root → deny", () => {
    expect(evalBashSafety(RF_ROOT).kind).toBe("deny")
  })
  test("rm -rf ~ home → deny", () => {
    expect(evalBashSafety(RF_HOME).kind).toBe("deny")
  })
  test("--recursive --force absolute → deny", () => {
    expect(evalBashSafety(RF_LONG).kind).toBe("deny")
  })
  test("recursive force-delete of a relative build dir → allow (routine cleanup, no prompt)", () => {
    expect(evalBashSafety(RF_REL).kind).toBe("allow")
  })
  test("lockfile edit → deny (no prompt; regenerate via package manager)", () => {
    expect(evalPathSafety("package-lock.json").kind).toBe("deny")
    expect(evalPathSafety("a/b/yarn.lock").kind).toBe("deny")
  })
  test("plain ls is allowed", () => {
    expect(evalBashSafety("ls -la").kind).toBe("allow")
  })
})

describe("briefs exemption (BUILD-SPEC §2)", () => {
  test("briefs/ stays model-writable", () => {
    expect(evalPathSafety(".claude-hooks/briefs/w1.json").kind).toBe("allow")
  })
  test("other .claude-hooks paths stay protected", () => {
    expect(evalPathSafety(".claude-hooks/other.txt").kind).toBe("deny")
    expect(evalPathSafety(".claude-hooks/baseline.json").kind).toBe("deny")
  })
})
