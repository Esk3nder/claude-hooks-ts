import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadProbes,
  matchProbes,
  parseTestStrategy,
  PROBE_TIMEOUT_MS,
  probesPathFor,
  resolveProbe,
  runProbe,
  type Probe,
  type ProbeFn,
} from "../../../src/algorithm/isa/probes.ts"
import type { CriterionEntry } from "../../../src/algorithm/isa/criteria.ts"

const c = (
  id: string,
  description = "x",
  status: "pending" | "completed" = "pending",
): CriterionEntry => ({ id, description, status, type: "criterion" })

const stage = (): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "chts-probes-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const writeProbesFile = (root: string, src: string): void => {
  mkdirSync(join(root, ".claude-hooks"), { recursive: true })
  writeFileSync(probesPathFor(root), src, "utf-8")
}

describe("probesPathFor / PROBE_TIMEOUT_MS", () => {
  test("path defaults to <cwd>/.claude-hooks/probes.ts", () => {
    expect(probesPathFor("/tmp/x")).toBe("/tmp/x/.claude-hooks/probes.ts")
  })
  test("PROBE_TIMEOUT_MS is 1000ms", () => {
    expect(PROBE_TIMEOUT_MS).toBe(1000)
  })
})

describe("loadProbes — hot-load contract", () => {
  test("returns frozen empty object when file missing", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await loadProbes(root)
      expect(Object.keys(out).length).toBe(0)
      expect(Object.isFrozen(out)).toBe(true)
    } finally {
      cleanup()
    }
  })

  test("loads valid module with `probes` export", async () => {
    const { root, cleanup } = stage()
    try {
      writeProbesFile(
        root,
        `export const probes = {
          "always-true": () => true,
          "always-false": () => false,
        }`,
      )
      const out = await loadProbes(root)
      expect(Object.keys(out).sort()).toEqual(["always-false", "always-true"])
      expect(typeof out["always-true"]).toBe("function")
    } finally {
      cleanup()
    }
  })

  test("returns empty when `probes` export is missing", async () => {
    const { root, cleanup } = stage()
    try {
      writeProbesFile(root, `export const other = {}`)
      const out = await loadProbes(root)
      expect(Object.keys(out).length).toBe(0)
    } finally {
      cleanup()
    }
  })

  test("returns empty when `probes` is non-object", async () => {
    const { root, cleanup } = stage()
    try {
      writeProbesFile(root, `export const probes = "string-not-object"`)
      const out = await loadProbes(root)
      expect(Object.keys(out).length).toBe(0)
    } finally {
      cleanup()
    }
  })

  test("returns empty when `probes` is an array", async () => {
    const { root, cleanup } = stage()
    try {
      writeProbesFile(root, `export const probes = [() => true]`)
      const out = await loadProbes(root)
      expect(Object.keys(out).length).toBe(0)
    } finally {
      cleanup()
    }
  })

  test("filters out non-function entries", async () => {
    const { root, cleanup } = stage()
    try {
      writeProbesFile(
        root,
        `export const probes = {
          good: () => true,
          bad: "not a function",
          alsobad: 42,
        }`,
      )
      const out = await loadProbes(root)
      expect(Object.keys(out)).toEqual(["good"])
    } finally {
      cleanup()
    }
  })

  test("returns empty (logs error) when module throws on import", async () => {
    const { root, cleanup } = stage()
    try {
      writeProbesFile(root, `throw new Error("boom"); export const probes = {}`)
      const out = await loadProbes(root)
      expect(Object.keys(out).length).toBe(0)
    } finally {
      cleanup()
    }
  })
})

describe("runProbe — Effect with timeout + error containment", () => {
  test("returns true when probe returns true", async () => {
    const probe: ProbeFn = () => true
    const result = await Effect.runPromise(runProbe(probe, c("ISC-1")))
    expect(result).toBe(true)
  })

  test("returns false when probe returns false", async () => {
    const probe: ProbeFn = () => false
    const result = await Effect.runPromise(runProbe(probe, c("ISC-1")))
    expect(result).toBe(false)
  })

  test("returns false when probe returns non-boolean (only strict true passes)", async () => {
    const truthy: ProbeFn = () => 1 as unknown as boolean
    const result = await Effect.runPromise(runProbe(truthy, c("ISC-1")))
    expect(result).toBe(false)
  })

  test("returns false when probe throws synchronously", async () => {
    const probe: ProbeFn = () => {
      throw new Error("sync fail")
    }
    const result = await Effect.runPromise(runProbe(probe, c("ISC-1")))
    expect(result).toBe(false)
  })

  test("returns false when probe rejects asynchronously", async () => {
    const probe: ProbeFn = async () => {
      throw new Error("async fail")
    }
    const result = await Effect.runPromise(runProbe(probe, c("ISC-1")))
    expect(result).toBe(false)
  })

  test("returns false when probe times out", async () => {
    const probe: ProbeFn = () =>
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5_000))
    const start = Date.now()
    const result = await Effect.runPromise(runProbe(probe, c("ISC-1"), 100))
    const elapsed = Date.now() - start
    expect(result).toBe(false)
    expect(elapsed).toBeLessThan(1_000) // timed out at 100ms, not waited 5s
  })

  test("passes the criterion through to the probe", async () => {
    let captured: CriterionEntry | null = null
    const probe: ProbeFn = (criterion) => {
      captured = criterion
      return true
    }
    await Effect.runPromise(runProbe(probe, c("ISC-7", "specific text")))
    expect((captured as unknown as CriterionEntry | null)?.id).toBe("ISC-7")
    expect((captured as unknown as CriterionEntry | null)?.description).toBe(
      "specific text",
    )
  })
})

// T1.5 — non-trivial probes (e.g. running `bun test`) need >1s. The
// default cap silently kills any probe that runs real work and returns
// `false` indistinguishably from "probe deterministically failed."
// The {fn, timeoutMs} spec form lets a probe declare the budget it needs.
describe("resolveProbe / probe spec — per-probe timeout configuration", () => {
  test("resolveProbe: bare function uses default timeout", () => {
    const fn: ProbeFn = () => true
    const r = resolveProbe(fn)
    expect(r.fn).toBe(fn)
    expect(r.timeoutMs).toBe(PROBE_TIMEOUT_MS)
  })

  test("resolveProbe: {fn, timeoutMs} object form passes timeoutMs through", () => {
    const fn: ProbeFn = () => true
    const r = resolveProbe({ fn, timeoutMs: 8_000 })
    expect(r.fn).toBe(fn)
    expect(r.timeoutMs).toBe(8_000)
  })

  test("resolveProbe: {fn} without explicit timeoutMs defaults", () => {
    const fn: ProbeFn = () => true
    const r = resolveProbe({ fn })
    expect(r.timeoutMs).toBe(PROBE_TIMEOUT_MS)
  })

  test("loadProbes accepts {fn, timeoutMs} export shape", async () => {
    const { root, cleanup } = stage()
    try {
      writeProbesFile(
        root,
        `export const probes = {
          "fast": () => true,
          "slow": { fn: () => true, timeoutMs: 8000 },
        }`,
      )
      const out = await loadProbes(root)
      expect(Object.keys(out).sort()).toEqual(["fast", "slow"])
      // Bare function passes through unchanged
      expect(typeof out["fast"]).toBe("function")
      // Spec object passes through with both fields
      const slow = out["slow"] as { fn: ProbeFn; timeoutMs?: number }
      expect(typeof slow?.fn).toBe("function")
      expect(slow?.timeoutMs).toBe(8000)
    } finally {
      cleanup()
    }
  })

  test("loadProbes rejects malformed spec (no `fn`)", async () => {
    const { root, cleanup } = stage()
    try {
      writeProbesFile(
        root,
        `export const probes = {
          "broken": { timeoutMs: 5000 },
        }`,
      )
      const out = await loadProbes(root)
      expect(Object.keys(out)).toEqual([])
    } finally {
      cleanup()
    }
  })

  test("end-to-end: probe sleeping 1.5s with timeoutMs=5000 succeeds (would have died at default 1s)", async () => {
    const slow: Probe = {
      fn: () =>
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(true), 1_500),
        ),
      timeoutMs: 5_000,
    }
    const { fn, timeoutMs } = resolveProbe(slow)
    const start = Date.now()
    const result = await Effect.runPromise(runProbe(fn, c("ISC-1"), timeoutMs))
    const elapsed = Date.now() - start
    expect(result).toBe(true)
    expect(elapsed).toBeGreaterThanOrEqual(1_400)
  }, 10_000)
})

describe("parseTestStrategy — pipe-table → iscId→probeName map", () => {
  test("parses canonical 5-cell rows", () => {
    const body = `| isc | type | check | threshold | tool |
| --- | --- | --- | --- | --- |
| ISC-1 | bash | smoke | 0 | always-true |
| ISC-2 | grep | match | 1 | grep-impl |`
    const m = parseTestStrategy(body)
    expect(m.size).toBe(2)
    expect(m.get("ISC-1")).toBe("always-true")
    expect(m.get("ISC-2")).toBe("grep-impl")
  })

  test("ignores rows whose first cell is not an ISC id", () => {
    const body = `| ISC-1 | x | y | z | probe-a |
| header | x | y | z | not-a-probe |`
    const m = parseTestStrategy(body)
    expect(m.size).toBe(1)
    expect(m.get("ISC-1")).toBe("probe-a")
  })

  test("skips separator row", () => {
    const body = `| ISC-1 | a | b | c | p1 |
| --- | --- | --- | --- | --- |
| ISC-2 | a | b | c | p2 |`
    const m = parseTestStrategy(body)
    expect(m.size).toBe(2)
  })

  test("skips empty body", () => {
    expect(parseTestStrategy("").size).toBe(0)
    expect(parseTestStrategy("\n\n  \n").size).toBe(0)
  })

  test("skips rows where last cell is empty", () => {
    const body = `| ISC-1 | x | x | x |   |`
    expect(parseTestStrategy(body).size).toBe(0)
  })

  test("handles 2-cell minimum (ISC + probe)", () => {
    const body = `| ISC-1 | shorthand-probe |`
    const m = parseTestStrategy(body)
    expect(m.get("ISC-1")).toBe("shorthand-probe")
  })

  test("supports nested ISC ids (ISC-1.2)", () => {
    const body = `| ISC-1.2 | x | x | x | nested |`
    expect(parseTestStrategy(body).get("ISC-1.2")).toBe("nested")
  })

  test("supports domain-prefixed ISC ids (ISC-CLI-3)", () => {
    const body = `| ISC-CLI-3 | x | x | x | cli-probe |`
    expect(parseTestStrategy(body).get("ISC-CLI-3")).toBe("cli-probe")
  })

  // Anchor contract: the first cell must be a bare ID and nothing else.
  // Pre-anchor, `^ISC-[\w.-]+/` matched `ISC-1: foo` and the WHOLE cell
  // (after trim) became the map key. parseCriteriaList only ever produces
  // bare IDs ("ISC-1"), so any garbled key was a silent no-match later
  // — probes existed in the registry, the ISA pointed at them, but the
  // bridging code couldn't find the pair. Anchored: garbled cells are
  // skipped entirely, surfacing as a clean "no probe match" signal
  // through matchProbes' onMiss callback when the user fixes the table.
  test("anchored: cell `ISC-1: my criterion` does NOT register", () => {
    const body = `| ISC-1: my criterion | x | x | x | tool-name |`
    const m = parseTestStrategy(body)
    // Neither key shape registers — neither the bare id nor the full cell.
    expect(m.size).toBe(0)
    expect(m.has("ISC-1")).toBe(false)
    expect(m.has("ISC-1: my criterion")).toBe(false)
  })

  test("anchored: cell `ISC-1 [F]` (legacy category bracket) does NOT register", () => {
    // Legacy ISAs that put the category bracket in the first cell of the
    // Test Strategy table need to move it to its own column or drop it.
    // The Criteria parser tolerates `[F]`; the Test Strategy parser does
    // not, by design — the strategy table's first cell is the join key.
    const body = `| ISC-1 [F] | x | x | x | tool |`
    expect(parseTestStrategy(body).size).toBe(0)
  })

  test("anchored: cell `ISC-1 ` (trailing whitespace only) STILL registers", () => {
    // After trim() inside the parser, trailing space disappears. We don't
    // want to be so strict we reject formatting variations that don't
    // actually carry information.
    const body = `| ISC-1     | x | x | x | tool |`
    expect(parseTestStrategy(body).get("ISC-1")).toBe("tool")
  })

  test("anchored: cell with embedded space `ISC-1 extra` does NOT register", () => {
    // Distinct from trailing whitespace: an internal token after the id
    // is information the parser can't interpret. Reject rather than
    // guess.
    const body = `| ISC-1 extra | x | x | x | tool |`
    expect(parseTestStrategy(body).size).toBe(0)
  })
})

describe("matchProbes — pure pairing function", () => {
  const registry: Readonly<Record<string, ProbeFn>> = {
    "p-true": () => true,
    "p-false": () => false,
  }

  test("matches pending criteria with declared + registered probes", () => {
    const criteria = [c("ISC-1"), c("ISC-2"), c("ISC-3")]
    const ts = new Map([
      ["ISC-1", "p-true"],
      ["ISC-2", "p-false"],
      ["ISC-3", "missing-probe"],
    ])
    const matches = matchProbes(criteria, ts, registry)
    expect(matches.map((m) => m.criterion.id).sort()).toEqual(["ISC-1", "ISC-2"])
  })

  test("skips already-completed criteria (idempotent)", () => {
    const criteria = [c("ISC-1", "x", "completed"), c("ISC-2")]
    const ts = new Map([
      ["ISC-1", "p-true"],
      ["ISC-2", "p-true"],
    ])
    const matches = matchProbes(criteria, ts, registry)
    expect(matches.map((m) => m.criterion.id)).toEqual(["ISC-2"])
  })

  test("returns empty when registry is empty", () => {
    const criteria = [c("ISC-1")]
    const ts = new Map([["ISC-1", "p-true"]])
    expect(matchProbes(criteria, ts, {}).length).toBe(0)
  })

  test("returns empty when test-strategy map is empty", () => {
    const criteria = [c("ISC-1")]
    expect(matchProbes(criteria, new Map(), registry).length).toBe(0)
  })

  test("invokes onMiss when ISA declares a probe absent from the registry", () => {
    const criteria = [c("ISC-1"), c("ISC-2")]
    const ts = new Map([
      ["ISC-1", "p-true"],
      ["ISC-2", "tests-pass"],
    ])
    const misses: Array<{
      iscId: string
      probeName: string
      registeredNames: ReadonlyArray<string>
    }> = []
    const matches = matchProbes(criteria, ts, registry, (m) => {
      misses.push({ ...m })
    })
    expect(matches.map((m) => m.criterion.id)).toEqual(["ISC-1"])
    expect(misses.length).toBe(1)
    expect(misses[0]?.iscId).toBe("ISC-2")
    expect(misses[0]?.probeName).toBe("tests-pass")
    expect([...(misses[0]?.registeredNames ?? [])].sort()).toEqual([
      "p-false",
      "p-true",
    ])
  })

  test("does not invoke onMiss for completed criteria or undeclared probes", () => {
    const criteria = [
      c("ISC-1", "x", "completed"),
      c("ISC-2"), // pending but no testStrategy entry
    ]
    const ts = new Map([["ISC-1", "tests-pass"]])
    const misses: string[] = []
    matchProbes(criteria, ts, registry, (m) => {
      misses.push(m.iscId)
    })
    expect(misses).toEqual([])
  })

  test("does not invoke onMiss when probe is found", () => {
    const criteria = [c("ISC-1")]
    const ts = new Map([["ISC-1", "p-true"]])
    let called = false
    matchProbes(criteria, ts, registry, () => {
      called = true
    })
    expect(called).toBe(false)
  })

  test("onMiss reports an empty registeredNames list when registry is empty", () => {
    const criteria = [c("ISC-1")]
    const ts = new Map([["ISC-1", "tests-pass"]])
    const misses: Array<ReadonlyArray<string>> = []
    matchProbes(criteria, ts, {}, (m) => {
      misses.push(m.registeredNames)
    })
    expect(misses.length).toBe(1)
    expect(misses[0]).toEqual([])
  })
})
