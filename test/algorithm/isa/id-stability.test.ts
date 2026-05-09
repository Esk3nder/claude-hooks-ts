import { describe, expect, test } from "bun:test"
import { validateIdStability } from "../../../src/algorithm/isa/id-stability.ts"
import type { CriterionEntry } from "../../../src/algorithm/isa/criteria.ts"

const c = (
  id: string,
  description: string,
  status: "pending" | "completed" = "pending",
  type: "criterion" | "anti-criterion" = "criterion",
): CriterionEntry => ({ id, description, status, type })

describe("validateIdStability — IsaFormat.md line 207-209 doctrine", () => {
  test("unchanged criteria → ok", () => {
    const before = [c("ISC-1", "build the thing"), c("ISC-2", "ship the thing")]
    const after = [c("ISC-1", "build the thing"), c("ISC-2", "ship the thing")]
    const r = validateIdStability(before, after)
    expect(r.ok).toBe(true)
    expect(r.violations.length).toBe(0)
    expect(r.orphanedIds.length).toBe(0)
  })

  test("text-only edit (same id) → ok", () => {
    const before = [c("ISC-1", "build the thing")]
    const after = [c("ISC-1", "build the thing properly")]
    expect(validateIdStability(before, after).ok).toBe(true)
  })

  test("split ISC-7 → ISC-7.1 + ISC-7.2 → ok (parent dropped, children present)", () => {
    const before = [c("ISC-7", "the big criterion")]
    const after = [
      c("ISC-7.1", "first half"),
      c("ISC-7.2", "second half"),
    ]
    const r = validateIdStability(before, after)
    expect(r.ok).toBe(true)
  })

  test("split ISC-7 → ISC-7 + ISC-7.1 (parent preserved) → ok", () => {
    const before = [c("ISC-7", "original")]
    const after = [c("ISC-7", "original"), c("ISC-7.1", "new child")]
    expect(validateIdStability(before, after).ok).toBe(true)
  })

  test("nested split ISC-7 → ISC-7.1.2 → ok (multi-level descendant)", () => {
    const before = [c("ISC-7", "x")]
    const after = [c("ISC-7.1.2", "x deeply nested")]
    expect(validateIdStability(before, after).ok).toBe(true)
  })

  test("tombstone (DROPPED) → ok", () => {
    const before = [c("ISC-3", "going away")]
    const after = [c("ISC-3", "[DROPPED — see Decisions]")]
    expect(validateIdStability(before, after).ok).toBe(true)
  })

  test("RENAME violation (ISC-3 → ISC-9 with same description)", () => {
    const before = [c("ISC-3", "build the thing")]
    const after = [c("ISC-9", "build the thing")]
    const r = validateIdStability(before, after)
    expect(r.ok).toBe(false)
    expect(r.violations.length).toBe(1)
    expect(r.violations[0]?.beforeId).toBe("ISC-3")
    expect(r.violations[0]?.afterId).toBe("ISC-9")
    expect(r.violations[0]?.kind).toBe("renumbered")
  })

  test("RENAME with whitespace/anti-prefix normalized", () => {
    const before = [c("ISC-2", "  Anti: must not break X  ", "pending", "anti-criterion")]
    const after = [c("ISC-99", "Anti: must not break X")]
    const r = validateIdStability(before, after)
    expect(r.ok).toBe(false)
    expect(r.violations[0]?.beforeId).toBe("ISC-2")
    expect(r.violations[0]?.afterId).toBe("ISC-99")
  })

  test("two unrelated criteria with similar text are NOT flagged as renames", () => {
    // Both before and after have ISC-1 and ISC-2. Same descriptions. The
    // descriptionHash → multiple after-entries map exists, but neither is a
    // "missing before-id whose text re-appeared elsewhere" — so no violation.
    const before = [c("ISC-1", "build x"), c("ISC-2", "ship x")]
    const after = [c("ISC-1", "build x"), c("ISC-2", "ship x")]
    expect(validateIdStability(before, after).ok).toBe(true)
  })

  test("orphaned id (disappeared, no tombstone, no split, no rename match) → diagnostic", () => {
    const before = [c("ISC-5", "unique original criterion text")]
    const after: CriterionEntry[] = [] // gone with no trace
    const r = validateIdStability(before, after)
    expect(r.ok).toBe(true) // orphan is NOT a violation per doctrine
    expect(r.orphanedIds).toEqual(["ISC-5"])
  })

  test("description containing ISC-N tokens does not cause false-positive matches", () => {
    // Both criteria mention ISC-7 in their text but have different ids.
    // Normalization replaces ISC-* tokens before hashing.
    const before = [c("ISC-7", "depends on ISC-3 to pass")]
    const after = [c("ISC-7", "depends on ISC-3 to pass")]
    expect(validateIdStability(before, after).ok).toBe(true)
  })

  test("multiple violations in one diff", () => {
    const before = [c("ISC-1", "alpha task"), c("ISC-2", "beta task")]
    const after = [c("ISC-10", "alpha task"), c("ISC-20", "beta task")]
    const r = validateIdStability(before, after)
    expect(r.violations.length).toBe(2)
    expect(r.violations.map((v) => v.beforeId).sort()).toEqual(["ISC-1", "ISC-2"])
  })
})
