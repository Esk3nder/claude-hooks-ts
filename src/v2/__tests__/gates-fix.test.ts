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

describe("bash write-target gate (F2 redirect-bypass closure)", () => {
  test("redirect into a protected path → deny", () => {
    expect(evalBashSafety("echo '{}' > .claude-hooks/policy.json").kind).toBe("deny")
  })
  test("quoted redirect target into a protected path → deny (no quote bypass)", () => {
    expect(evalBashSafety('printf x > ".claude-hooks/baseline.json"').kind).toBe("deny")
  })
  test("append redirect into .git → deny", () => {
    expect(evalBashSafety("echo x >> .git/config").kind).toBe("deny")
  })
  test("redirect into a secret path → deny", () => {
    expect(evalBashSafety("echo k > deploy/id_rsa").kind).toBe("deny")
  })
  test("tee into a protected path → deny", () => {
    expect(evalBashSafety("echo x | tee .claude-hooks/policy.json").kind).toBe("deny")
  })
  test("cp/mv destination in a protected path → deny", () => {
    expect(evalBashSafety("cp /tmp/x .claude-hooks/policy.json").kind).toBe("deny")
    expect(evalBashSafety("mv a.json .claude-hooks/policy.json").kind).toBe("deny")
  })
  test("dd of= a secret path → deny", () => {
    expect(evalBashSafety("dd if=/dev/zero of=.aws/credentials").kind).toBe("deny")
  })
  test("redirect into briefs/ stays allowed (model-writable by design)", () => {
    expect(evalBashSafety("echo '{}' > .claude-hooks/briefs/w1.json").kind).toBe("allow")
  })
  test("ordinary redirect to a normal file → allow", () => {
    expect(evalBashSafety("bun test > out.log 2>&1").kind).toBe("allow")
  })
  test("2>&1 alone creates no bogus target → allow", () => {
    expect(evalBashSafety("make 2>&1").kind).toBe("allow")
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
