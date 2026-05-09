import { describe, expect, test } from "bun:test"
import {
  THINKING_CAPABILITIES,
  auditCapabilityNames,
  extractCapabilityNames,
} from "../../src/algorithm/capabilities.ts"

describe("THINKING_CAPABILITIES — Algorithm v6.3.0:43-62 verbatim pin", () => {
  test("contains exactly 19 names", () => {
    expect(THINKING_CAPABILITIES.length).toBe(19)
  })

  test("preserves doctrinal order (changes here require a doctrine update)", () => {
    expect([...THINKING_CAPABILITIES]).toEqual([
      "IterativeDepth",
      "ApertureOscillation",
      "FeedbackMemoryConsult",
      "Advisor",
      "ReReadCheck",
      "FirstPrinciples",
      "SystemsThinking",
      "RootCauseAnalysis",
      "Council",
      "RedTeam",
      "Science",
      "BeCreative",
      "Ideate",
      "BitterPillEngineering",
      "Evals",
      "WorldThreatModel",
      "Fabric patterns",
      "ContextSearch",
      "ISA",
    ])
  })

  test("includes the four 'doctrinal' built-ins", () => {
    // ReReadCheck (mandatory final gate, all tiers), Advisor (commitment-
    // boundary review), FeedbackMemoryConsult (PLAN first step at E2+),
    // ISA (mandatory at E2+). These are the load-bearing ones.
    for (const name of ["ReReadCheck", "Advisor", "FeedbackMemoryConsult", "ISA"]) {
      expect(THINKING_CAPABILITIES).toContain(name)
    }
  })

  test("Fabric capability is the two-word 'Fabric patterns', NOT short 'Fabric'", () => {
    // Doctrine line 60 lists '**Fabric patterns**' — the verbatim closed-list
    // name is two words. The Skill invocation uses short 'Fabric', but the
    // audit gate matches the long form.
    expect(THINKING_CAPABILITIES).toContain("Fabric patterns")
    expect(THINKING_CAPABILITIES).not.toContain("Fabric")
  })
})

describe("auditCapabilityNames — pure phantom validator", () => {
  test("ok=true on empty selection", () => {
    const r = auditCapabilityNames([])
    expect(r.ok).toBe(true)
    expect(r.phantoms).toEqual([])
    expect(r.valid).toEqual([])
    expect(r.message).toBe("")
  })

  test("ok=true on all-valid selection", () => {
    const r = auditCapabilityNames(["IterativeDepth", "FirstPrinciples", "ISA"])
    expect(r.ok).toBe(true)
    expect(r.valid).toEqual(["IterativeDepth", "FirstPrinciples", "ISA"])
    expect(r.phantoms).toEqual([])
  })

  test("ok=false on any phantom; lists phantoms with helpful message", () => {
    const r = auditCapabilityNames([
      "IterativeDepth",
      "decomposition", // phantom
      "deep reasoning", // phantom
    ])
    expect(r.ok).toBe(false)
    expect(r.phantoms).toEqual(["decomposition", "deep reasoning"])
    expect(r.valid).toEqual(["IterativeDepth"])
    expect(r.message).toContain("Phantom thinking capabilities")
    expect(r.message).toContain("decomposition")
    expect(r.message).toContain("deep reasoning")
    expect(r.message).toContain("Algorithm v6.3.0")
  })

  test("case-sensitive (paraphrase rejection per doctrine line 65)", () => {
    // 'iterativedepth' lowercase is a phantom; doctrine bans paraphrases.
    expect(auditCapabilityNames(["iterativedepth"]).ok).toBe(false)
    expect(auditCapabilityNames(["Iterative Depth"]).ok).toBe(false)
    expect(auditCapabilityNames(["First-principles"]).ok).toBe(false)
  })

  test("ignores non-string entries defensively", () => {
    // Defensive — JSON-decoded inputs from text parsers may slip nulls.
    const r = auditCapabilityNames([
      "ISA",
      undefined as unknown as string,
      null as unknown as string,
      42 as unknown as string,
    ])
    expect(r.valid).toEqual(["ISA"])
    expect(r.phantoms).toEqual([])
    expect(r.ok).toBe(true)
  })

  test("preserves selection order in the report", () => {
    const r = auditCapabilityNames(["Council", "RedTeam", "fakery"])
    expect(r.valid).toEqual(["Council", "RedTeam"])
    expect(r.phantoms).toEqual(["fakery"])
  })
})

describe("extractCapabilityNames — parse 🏹-prefixed model output / ISA Decisions", () => {
  test("extracts bold form: 🏹 **Name** → ...", () => {
    const text = `🏹 CAPABILITIES SELECTED:
🏹 **IterativeDepth** → THINK | exploring options
🏹 **FirstPrinciples** → THINK | rebuild from physics
🏹 **RedTeam** → VERIFY | stress test`
    expect(extractCapabilityNames(text)).toEqual([
      "IterativeDepth",
      "FirstPrinciples",
      "RedTeam",
    ])
  })

  test("skips the doctrinal CAPABILITIES SELECTED header line", () => {
    const text = `🏹 CAPABILITIES SELECTED:
🏹 **ISA** → OBSERVE | scaffold`
    expect(extractCapabilityNames(text)).toEqual(["ISA"])
  })

  test("falls back to plain form when no bold markers", () => {
    const text = `🏹 ContextSearch → OBSERVE | recovery`
    expect(extractCapabilityNames(text)).toEqual(["ContextSearch"])
  })

  test("supports the pipe '|' separator without arrow", () => {
    const text = `🏹 Council | THINK boundary`
    expect(extractCapabilityNames(text)).toEqual(["Council"])
  })

  test("returns [] when no 🏹 lines present", () => {
    expect(extractCapabilityNames("nothing here")).toEqual([])
  })

  test("composes with auditCapabilityNames", () => {
    const text = `🏹 CAPABILITIES SELECTED:
🏹 **IterativeDepth** → THINK
🏹 **decomposition** → THINK | phantom alert`
    const names = extractCapabilityNames(text)
    const audit = auditCapabilityNames(names)
    expect(audit.ok).toBe(false)
    expect(audit.phantoms).toEqual(["decomposition"])
  })
})
