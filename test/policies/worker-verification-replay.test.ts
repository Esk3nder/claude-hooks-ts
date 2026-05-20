/**
 * US-1c — worker behavioral verification replay (pure decision tests).
 *
 * The pure policy takes worker claims and replay results and decides
 * whether to block the SubagentStop on disagreement. The wrapper in
 * events/subagent-scope-gate.ts is responsible for loading probes and
 * running them; this file pins the agreement-vs-disagreement matrix.
 */
import { describe, expect, test } from "bun:test"
import {
  evaluateVerificationReplay,
  type WorkerVerificationClaim,
} from "../../src/policies/worker-verification-replay.ts"

const baseClaim = (
  check: string,
  status: WorkerVerificationClaim["status"],
): WorkerVerificationClaim => ({
  check,
  status,
  evidence: "the worker said so",
})

describe("evaluateVerificationReplay — short-circuits", () => {
  test("no claims → passthrough", () => {
    const v = evaluateVerificationReplay({ claims: [], replays: [] })
    expect(v.kind).toBe("passthrough")
  })

  test("only not_run claims → passthrough", () => {
    const v = evaluateVerificationReplay({
      claims: [
        baseClaim("typecheck", "not_run"),
        baseClaim("tests", "not_run"),
      ],
      replays: [],
    })
    expect(v.kind).toBe("passthrough")
  })

  test("claim has no matching replay → passthrough (unverifiable, not unverified)", () => {
    const v = evaluateVerificationReplay({
      claims: [baseClaim("typecheck", "passed")],
      replays: [],
    })
    expect(v.kind).toBe("passthrough")
  })
})

describe("evaluateVerificationReplay — agreement", () => {
  test("worker claims passed + replay passes → passthrough", () => {
    const v = evaluateVerificationReplay({
      claims: [baseClaim("typecheck", "passed")],
      replays: [{ check: "typecheck", passed: true }],
    })
    expect(v.kind).toBe("passthrough")
  })

  test("worker claims failed + replay fails → passthrough", () => {
    const v = evaluateVerificationReplay({
      claims: [baseClaim("tests", "failed")],
      replays: [{ check: "tests", passed: false }],
    })
    expect(v.kind).toBe("passthrough")
  })

  test("multiple agreement → passthrough", () => {
    const v = evaluateVerificationReplay({
      claims: [
        baseClaim("typecheck", "passed"),
        baseClaim("tests", "passed"),
        baseClaim("lint", "failed"),
      ],
      replays: [
        { check: "typecheck", passed: true },
        { check: "tests", passed: true },
        { check: "lint", passed: false },
      ],
    })
    expect(v.kind).toBe("passthrough")
  })
})

describe("evaluateVerificationReplay — disagreement blocks", () => {
  test("worker claims passed + replay fails → block (the big one)", () => {
    const v = evaluateVerificationReplay({
      claims: [baseClaim("typecheck", "passed")],
      replays: [{ check: "typecheck", passed: false }],
    })
    expect(v.kind).toBe("block")
    if (v.kind === "block") {
      expect(v.reason).toContain("verification_replay_failed")
      expect(v.reason).toContain("typecheck")
      expect(v.reason).toMatch(/claim(ed)?.*pass/i)
      expect(v.reason).toMatch(/replay.*fail/i)
    }
  })

  test("worker claims failed + replay passes → block (false-failure also surfaced)", () => {
    const v = evaluateVerificationReplay({
      claims: [baseClaim("tests", "failed")],
      replays: [{ check: "tests", passed: true }],
    })
    expect(v.kind).toBe("block")
    expect(v.kind === "block" && v.reason).toContain("tests")
  })

  test("mixed agreement and disagreement → block; reason names only disagreements", () => {
    const v = evaluateVerificationReplay({
      claims: [
        baseClaim("typecheck", "passed"),
        baseClaim("tests", "passed"),
        baseClaim("lint", "passed"),
      ],
      replays: [
        { check: "typecheck", passed: true },
        { check: "tests", passed: false },
        { check: "lint", passed: true },
      ],
    })
    expect(v.kind).toBe("block")
    if (v.kind === "block") {
      expect(v.reason).toContain("tests")
      expect(v.reason).not.toMatch(/\btypecheck\b.*claim/i)
      expect(v.reason).not.toMatch(/\blint\b.*claim/i)
    }
  })

  test("not_run claim with passing replay → passthrough (worker honest)", () => {
    const v = evaluateVerificationReplay({
      claims: [baseClaim("typecheck", "not_run")],
      replays: [{ check: "typecheck", passed: true }],
    })
    expect(v.kind).toBe("passthrough")
  })

  test("not_run claim with failing replay → passthrough", () => {
    const v = evaluateVerificationReplay({
      claims: [baseClaim("typecheck", "not_run")],
      replays: [{ check: "typecheck", passed: false }],
    })
    expect(v.kind).toBe("passthrough")
  })
})

describe("evaluateVerificationReplay — duplicate / multiple claims for same check", () => {
  test("two claims for same check, both passed, replay passes → passthrough", () => {
    const v = evaluateVerificationReplay({
      claims: [
        baseClaim("typecheck", "passed"),
        baseClaim("typecheck", "passed"),
      ],
      replays: [{ check: "typecheck", passed: true }],
    })
    expect(v.kind).toBe("passthrough")
  })

  test("two claims for same check, one passed one not_run, replay passes → passthrough", () => {
    const v = evaluateVerificationReplay({
      claims: [
        baseClaim("typecheck", "passed"),
        baseClaim("typecheck", "not_run"),
      ],
      replays: [{ check: "typecheck", passed: true }],
    })
    expect(v.kind).toBe("passthrough")
  })

  test("two claims for same check, one passed (with failing replay) → block", () => {
    // If ANY non-not_run claim for a check disagrees with the replay, block.
    const v = evaluateVerificationReplay({
      claims: [
        baseClaim("typecheck", "passed"),
        baseClaim("typecheck", "not_run"),
      ],
      replays: [{ check: "typecheck", passed: false }],
    })
    expect(v.kind).toBe("block")
    expect(v.kind === "block" && v.reason).toContain("typecheck")
  })

  test("contradictory same-check claims (passed AND failed) + replay passes → block, disagreement named once", () => {
    // Worker contradicts itself for the same check. Replay says passed.
    // The `passed` claim agrees (ignored); the `failed` claim disagrees
    // (blocks). The disagreement should appear exactly once in the
    // reason — dedup keyed by check, not by (check, status).
    const v = evaluateVerificationReplay({
      claims: [
        baseClaim("typecheck", "passed"),
        baseClaim("typecheck", "failed"),
      ],
      replays: [{ check: "typecheck", passed: true }],
    })
    expect(v.kind).toBe("block")
    if (v.kind === "block") {
      const matches = v.reason.match(/typecheck: worker claimed/g) ?? []
      expect(matches.length).toBe(1)
    }
  })
})
