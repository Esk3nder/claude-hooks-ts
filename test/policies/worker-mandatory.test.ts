/**
 * US-2 worker-mandatory gate — pure decision tests. The wrapper in
 * events/pretool-policy.ts is covered by integration tests elsewhere.
 */
import { describe, expect, test } from "bun:test"
import {
  activeWorkerCount,
  evaluateWorkerMandatoryGate,
  type WorkerMandatoryMode,
} from "../../src/policies/worker-mandatory.ts"

const baseInput = {
  mode: "strict" as WorkerMandatoryMode,
  toolName: "Write",
  lastTier: 4 as number | null,
  activeWorkerCount: 0,
}

describe("activeWorkerCount", () => {
  test.each<[number, number, number]>([
    [0, 0, 0],
    [3, 0, 3],
    [3, 3, 0],
    [3, 5, 0], // never negative
    [10, 7, 3],
  ])("starts=%i, stops=%i → %i", (starts, stops, expected) => {
    expect(activeWorkerCount({ starts, stops })).toBe(expected)
  })
})

describe("evaluateWorkerMandatoryGate — short-circuits", () => {
  test("mode=off always passes through", () => {
    const v = evaluateWorkerMandatoryGate({
      ...baseInput,
      mode: "off",
      lastTier: 5,
      activeWorkerCount: 0,
    })
    expect(v.kind).toBe("passthrough")
  })

  test.each<[number | null, string]>([
    [null, "MINIMAL/NATIVE"],
    [1, "ALGORITHM E1"],
    [2, "ALGORITHM E2"],
    [3, "ALGORITHM E3"],
  ])("tier %p → passthrough (%s)", (tier) => {
    const v = evaluateWorkerMandatoryGate({ ...baseInput, lastTier: tier })
    expect(v.kind).toBe("passthrough")
  })

  test("Read tool at E5 → passthrough (non-write)", () => {
    const v = evaluateWorkerMandatoryGate({
      ...baseInput,
      toolName: "Read",
      lastTier: 5,
    })
    expect(v.kind).toBe("passthrough")
  })

  test("Bash at E5 → passthrough (Bash gating handled separately)", () => {
    const v = evaluateWorkerMandatoryGate({
      ...baseInput,
      toolName: "Bash",
      lastTier: 5,
    })
    expect(v.kind).toBe("passthrough")
  })

  test("Task tool at E5 → passthrough (the delegation tool itself)", () => {
    const v = evaluateWorkerMandatoryGate({
      ...baseInput,
      toolName: "Task",
      lastTier: 5,
    })
    expect(v.kind).toBe("passthrough")
  })
})

describe("evaluateWorkerMandatoryGate — active worker grants passthrough", () => {
  test("E4 + Write + 1 active worker + strict → allow", () => {
    const v = evaluateWorkerMandatoryGate({
      mode: "strict",
      toolName: "Write",
      lastTier: 4,
      activeWorkerCount: 1,
    })
    expect(v.kind).toBe("allow")
    expect(v.kind === "allow" && v.reason).toMatch(/worker is currently active/)
  })

  test("E5 + Edit + 3 active workers + recommend → allow", () => {
    const v = evaluateWorkerMandatoryGate({
      mode: "recommend",
      toolName: "Edit",
      lastTier: 5,
      activeWorkerCount: 3,
    })
    expect(v.kind).toBe("allow")
  })
})

describe("evaluateWorkerMandatoryGate — strict denies, recommend asks", () => {
  test.each<[string]>([
    ["Write"],
    ["Edit"],
    ["MultiEdit"],
    ["NotebookEdit"],
    ["Update"],
  ])("strict + E4 + %s + no active worker → deny", (toolName) => {
    const v = evaluateWorkerMandatoryGate({
      mode: "strict",
      toolName,
      lastTier: 4,
      activeWorkerCount: 0,
    })
    expect(v.kind).toBe("deny")
    expect(v.kind === "deny" && v.reason).toContain("worker-mandatory (strict mode)")
    expect(v.kind === "deny" && v.reason).toMatch(/Launch a Task/)
  })

  test.each<[string]>([["Write"], ["Edit"], ["MultiEdit"], ["NotebookEdit"], ["Update"]])(
    "recommend + E4 + %s + no active worker → ask",
    (toolName) => {
      const v = evaluateWorkerMandatoryGate({
        mode: "recommend",
        toolName,
        lastTier: 4,
        activeWorkerCount: 0,
      })
      expect(v.kind).toBe("ask")
      expect(v.kind === "ask" && v.reason).toContain("worker-mandatory (recommend mode)")
    },
  )

  test("E5 + Write + 0 workers + strict → deny", () => {
    const v = evaluateWorkerMandatoryGate({
      mode: "strict",
      toolName: "Write",
      lastTier: 5,
      activeWorkerCount: 0,
    })
    expect(v.kind).toBe("deny")
  })
})

describe("evaluateWorkerMandatoryGate — worker-session short-circuit (P0 from #54 review)", () => {
  test("isWorkerSession=true + strict + E5 + 0 active workers → passthrough (worker writes are OK)", () => {
    const v = evaluateWorkerMandatoryGate({
      mode: "strict",
      toolName: "Write",
      lastTier: 5,
      activeWorkerCount: 0,
      isWorkerSession: true,
    })
    expect(v.kind).toBe("passthrough")
  })

  test("isWorkerSession=true + recommend + E4 → passthrough", () => {
    const v = evaluateWorkerMandatoryGate({
      mode: "recommend",
      toolName: "Edit",
      lastTier: 4,
      activeWorkerCount: 0,
      isWorkerSession: true,
    })
    expect(v.kind).toBe("passthrough")
  })

  test("isWorkerSession=false (parent session) + strict + E5 + 0 active → deny (existing behavior preserved)", () => {
    const v = evaluateWorkerMandatoryGate({
      mode: "strict",
      toolName: "Write",
      lastTier: 5,
      activeWorkerCount: 0,
      isWorkerSession: false,
    })
    expect(v.kind).toBe("deny")
  })

  test("isWorkerSession omitted → treated as false (back-compat with existing callers)", () => {
    const v = evaluateWorkerMandatoryGate({
      mode: "strict",
      toolName: "Write",
      lastTier: 5,
      activeWorkerCount: 0,
    })
    expect(v.kind).toBe("deny")
  })
})

describe("evaluateWorkerMandatoryGate — worker lifecycle (active count derived)", () => {
  test("starts=2, stops=1 → 1 active → allow", () => {
    const active = activeWorkerCount({ starts: 2, stops: 1 })
    const v = evaluateWorkerMandatoryGate({
      mode: "strict",
      toolName: "Write",
      lastTier: 4,
      activeWorkerCount: active,
    })
    expect(v.kind).toBe("allow")
  })

  test("starts=2, stops=2 → 0 active → deny in strict", () => {
    const active = activeWorkerCount({ starts: 2, stops: 2 })
    const v = evaluateWorkerMandatoryGate({
      mode: "strict",
      toolName: "Write",
      lastTier: 4,
      activeWorkerCount: active,
    })
    expect(v.kind).toBe("deny")
  })

  test("starts=2, stops=5 → 0 active (clamped) → deny in strict", () => {
    const active = activeWorkerCount({ starts: 2, stops: 5 })
    expect(active).toBe(0)
    const v = evaluateWorkerMandatoryGate({
      mode: "strict",
      toolName: "Write",
      lastTier: 4,
      activeWorkerCount: active,
    })
    expect(v.kind).toBe("deny")
  })
})
