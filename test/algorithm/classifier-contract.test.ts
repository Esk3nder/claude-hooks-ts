/**
 * US-22 — Contract drift test.
 *
 * Reads the committed `docs/CLASSIFIER_CONTRACT.json` and compares it to
 * a fresh regeneration via `buildClassifierContract()`. If they diverge,
 * the test fails — same logic CI runs as `bun run contract:check`, but
 * without shelling out, so the failure is fast and the diff is visible
 * in test output.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  buildClassifierContract,
  CONTRACT_VERSION,
  serializeContract,
} from "../../src/algorithm/classifier-contract.ts"

const ARTIFACT_PATH = resolve(
  import.meta.dir,
  "..",
  "..",
  "docs",
  "CLASSIFIER_CONTRACT.json",
)

describe("classifier contract (US-22)", () => {
  it("committed artifact matches a fresh regeneration", () => {
    const onDisk = readFileSync(ARTIFACT_PATH, "utf8")
    const fresh = serializeContract(buildClassifierContract())
    expect(onDisk).toBe(fresh)
  })

  it("buildClassifierContract is deterministic", () => {
    const a = serializeContract(buildClassifierContract())
    const b = serializeContract(buildClassifierContract())
    expect(a).toBe(b)
  })

  it("contract reports the current schema version", () => {
    const c = buildClassifierContract()
    expect(c.version).toBe(CONTRACT_VERSION)
  })

  it("contract documents all four fast-path gates in order", () => {
    const c = buildClassifierContract()
    expect(c.fastPath.gates.map((g) => g.name)).toEqual([
      "explicit-rating",
      "positive-praise",
      "system-text",
      "short-prompt",
    ])
    expect(c.fastPath.gates.map((g) => g.order)).toEqual([1, 2, 3, 4])
  })

  it("constants are sorted (stable diff)", () => {
    const c = buildClassifierContract()
    const tokens = [...c.constants.shortContextTokens]
    const sortedTokens = [...tokens].sort()
    expect(tokens).toEqual(sortedTokens)

    const praise = [...c.constants.positivePraiseWords]
    const sortedPraise = [...praise].sort()
    expect(praise).toEqual(sortedPraise)
  })

  it("shortContextTokens includes the US-20 set", () => {
    const c = buildClassifierContract()
    for (const token of ["ok", "yes", "no", "go", "y", "n", "sure", "kk"]) {
      expect(c.constants.shortContextTokens).toContain(token)
    }
  })

  it("systemTextPatterns are regex source strings", () => {
    const c = buildClassifierContract()
    expect(c.constants.systemTextPatterns.length).toBeGreaterThan(0)
    for (const src of c.constants.systemTextPatterns) {
      expect(() => new RegExp(src)).not.toThrow()
    }
  })

  it("serializeContract ends with a trailing newline", () => {
    const s = serializeContract(buildClassifierContract())
    expect(s.endsWith("\n")).toBe(true)
  })
})
