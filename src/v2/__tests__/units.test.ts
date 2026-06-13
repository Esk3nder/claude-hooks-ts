import { describe, expect, test } from "bun:test"
import { deriveAuthority, canSpawn } from "../recursion.ts"
import { DEFAULTS } from "../config.ts"
import { shouldSample, onContradiction, type RoleStats } from "../sampling.ts"
import { panelVerdict } from "../panel.ts"
import { selectSpeculative } from "../speculative.ts"
import { evalBashSafety, evalPathSafety, evalCapability } from "../gates.ts"
import { validateBrief } from "../validate.ts"
import { ROLE_CAPS } from "../types.ts"

describe("recursion authority (§6.1)", () => {
  test("capabilities narrow with depth, never widen", () => {
    const orch = deriveAuthority("implementer", null)
    const childScout = deriveAuthority("scout", orch)
    expect(childScout.tools).toEqual(["Read", "Grep", "Glob"])
    // a scout parent cannot confer write
    const scout = deriveAuthority("scout", null)
    const grand = deriveAuthority("implementer", scout)
    expect(grand.tools).not.toContain("Write") // narrowed to parent's read-only
  })
  test("skeptic is leaf-only", () => {
    expect(deriveAuthority("skeptic", null).may_spawn).toBe(false)
    expect(deriveAuthority("scout", null).may_spawn).toBe(true)
  })
})

describe("canSpawn caps & cycles (§6.3, §6.4)", () => {
  const base = {
    parentAuthority: deriveAuthority("implementer", null), parentDepth: 0, childRole: "implementer" as const,
    childTools: [...ROLE_CAPS.implementer], ancestryLabels: ["root"], childLabel: "leg-a",
    childrenOfParent: 0, concurrentInSession: 0, sessionTokensSpent: 0, sessionWallclockMs: 0, policy: DEFAULTS,
  }
  test("scout parent → implementer child denied (capability widening)", () => {
    const d = canSpawn({ ...base, parentAuthority: deriveAuthority("scout", null) })
    expect(d.allow).toBe(false)
  })
  test("depth cap", () => {
    expect(canSpawn({ ...base, parentDepth: 2 }).allow).toBe(false)
  })
  test("cycle: label in ancestry", () => {
    expect(canSpawn({ ...base, childLabel: "root" }).allow).toBe(false)
  })
  test("concurrency cap", () => {
    expect(canSpawn({ ...base, concurrentInSession: 8 }).allow).toBe(false)
  })
  test("token budget", () => {
    expect(canSpawn({ ...base, sessionTokensSpent: 3_000_000 }).allow).toBe(false)
  })
  test("happy path allows", () => expect(canSpawn(base).allow).toBe(true))
})

describe("sampling (§8)", () => {
  const stats = (o: Partial<RoleStats>): RoleStats => ({ runs: 100, accepted: 99, sinceFullAudit: 0, eligible: true, ...o })
  test("never samples spine or high-risk or panel member", () => {
    expect(shouldSample({ policy: DEFAULTS, isSpine: true, risk: "low", isPanelMember: false, stats: stats({}), runIndex: 1 })).toBe(false)
    expect(shouldSample({ policy: DEFAULTS, isSpine: false, risk: "high", isPanelMember: false, stats: stats({}), runIndex: 1 })).toBe(false)
    expect(shouldSample({ policy: DEFAULTS, isSpine: false, risk: "low", isPanelMember: true, stats: stats({}), runIndex: 1 })).toBe(false)
  })
  test("ineligible below thresholds", () => {
    expect(shouldSample({ policy: DEFAULTS, isSpine: false, risk: "low", isPanelMember: false, stats: stats({ runs: 10 }), runIndex: 1 })).toBe(false)
    expect(shouldSample({ policy: DEFAULTS, isSpine: false, risk: "low", isPanelMember: false, stats: stats({ accepted: 80 }), runIndex: 1 })).toBe(false)
  })
  test("samples 4 of every 5 when eligible; full-verify every 5th", () => {
    const elig = stats({})
    expect(shouldSample({ policy: DEFAULTS, isSpine: false, risk: "low", isPanelMember: false, stats: elig, runIndex: 5 })).toBe(false) // index%5==0 → full
    expect(shouldSample({ policy: DEFAULTS, isSpine: false, risk: "low", isPanelMember: false, stats: elig, runIndex: 7 })).toBe(true)
  })
  test("contradiction resets eligibility", () => {
    expect(onContradiction(stats({})).eligible).toBe(false)
  })
})

describe("panel verdict (§7)", () => {
  test("2-of-3 refute → refuted", () => {
    const o = panelVerdict([{ lens: "a", verdict: "refuted" }, { lens: "b", verdict: "refuted" }, { lens: "c", verdict: "confirmed" }], 2)
    expect(o.verdict).toBe("refuted"); expect(o.dissent.length).toBe(1)
  })
  test("all confirm → confirmed", () => {
    expect(panelVerdict([{ lens: "a", verdict: "confirmed" }, { lens: "b", verdict: "confirmed" }], 2).verdict).toBe("confirmed")
  })
  test("split → inconclusive", () => {
    expect(panelVerdict([{ lens: "a", verdict: "refuted" }, { lens: "b", verdict: "confirmed" }, { lens: "c", verdict: "inconclusive" }], 2).verdict).toBe("inconclusive")
  })
})

describe("speculative selector (§10)", () => {
  test("winner = passes replay; fewest changed_files breaks ties", () => {
    const o = selectSpeculative([
      { agent_id: "a", replay_exit: 0, changed_files: 9, finished_seq: 1 },
      { agent_id: "b", replay_exit: 0, changed_files: 2, finished_seq: 3 },
      { agent_id: "c", replay_exit: 1, changed_files: 1, finished_seq: 2 },
    ])
    expect(o.winner).toBe("b"); expect(o.rejected).toContain("a"); expect(o.soft_failed).toContain("c")
  })
  test("none pass → all soft_failed", () => {
    const o = selectSpeculative([{ agent_id: "a", replay_exit: 1, changed_files: 1, finished_seq: 1 }])
    expect(o.winner).toBeNull(); expect(o.soft_failed).toEqual(["a"])
  })
})

describe("input gates (§6.1)", () => {
  test("destructive bash denied (security)", () => {
    const d = evalBashSafety("rm -rf /")
    expect(d.kind).toBe("deny")
  })
  test("secret + protected paths denied", () => {
    expect(evalPathSafety(".env").kind).toBe("deny")
    expect(evalPathSafety("src/.git/config").kind).toBe("deny")
    expect(evalPathSafety("src/ok.ts").kind).toBe("allow")
  })
  test("capability: scout cannot Write", () => {
    expect(evalCapability("Write", [...ROLE_CAPS.scout]).kind).toBe("deny")
    expect(evalCapability("Read", [...ROLE_CAPS.scout]).kind).toBe("allow")
    expect(evalCapability("Bash(pwd)", [...ROLE_CAPS.skeptic]).kind).toBe("allow")
  })
})

describe("brief validation (§5.1)", () => {
  const base = { schema_version: 1, role: "implementer", label: "fix-a" }
  test("scout cannot be spine-linked", () => {
    expect(validateBrief({ ...base, role: "scout", isc_id: "ISC1", acceptance: { argv: ["x"], cwd: ".", replay: "required", idempotent: true } }).ok).toBe(false)
  })
  test("warm requires implementer", () => {
    expect(validateBrief({ ...base, role: "skeptic", warm: true }).ok).toBe(false)
  })
  test("spine requires replay required + idempotent", () => {
    expect(validateBrief({ ...base, isc_id: "ISC1", acceptance: { argv: ["x"], cwd: ".", replay: "advisory", idempotent: true } }).ok).toBe(false)
    expect(validateBrief({ ...base, isc_id: "ISC1", acceptance: { argv: ["x"], cwd: ".", replay: "required", idempotent: true } }).ok).toBe(true)
  })
})
