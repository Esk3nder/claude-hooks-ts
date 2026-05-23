/**
 * Engagement tier/mode freeze — the ISA-completeness gate must compare the
 * ISA's `classifier_tier`/`classifier_mode` frontmatter against the tier
 * frozen AT FIRST engagement, not the per-turn `last_tier` that may
 * fluctuate as the classifier re-evaluates each user prompt.
 *
 * Before the fix: a mid-session classifier escalation (e.g. E3 → E4) wrote
 * the new tier into `last_tier`; the ISA gate then reported "expected E4,
 * got E3" on the existing ISA that was correctly authored under the
 * original E3 engagement.
 *
 * After the fix: `engagement_tier` is set once and never overwritten; the
 * gate prefers it over `last_tier`. Legacy records (no `engagement_tier`)
 * fall back to `last_tier` so old sessions keep their previous behavior.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { checkStopReadiness } from "../../../src/algorithm/isa/lifecycle.ts"

const stage = (
  isaContent: string,
): { cwd: string; cleanup: () => void } => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "chts-tier-freeze-"))
  const isaDir = path.join(cwd, ".claude-hooks", "work", "sid-1")
  mkdirSync(isaDir, { recursive: true })
  writeFileSync(path.join(isaDir, "ISA.md"), isaContent, "utf-8")
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) }
}

const ISA_E3 = `---
effort: advanced
phase: complete
classifier_mode: ALGORITHM
classifier_tier: E3
classifier_reason: fixture engaged at E3
---

## Problem
x

## Vision
x

## Out of Scope
x

## Constraints
x

## Goal
x

## Criteria
- [x] ISC-1: x

## Test Strategy
ISC-1 | unit | x | x | x

## Features
x | ISC-1 | none | yes

## Verification
- ISC-1: passed
`

describe("Engagement tier/mode freeze", () => {
  test("frozen engagement_tier=3 is preferred over an escalated last_tier=4", async () => {
    const { cwd, cleanup } = stage(ISA_E3)
    try {
      const verdict = checkStopReadiness({
        cwd,
        record: {
          engagement_required: true,
          expected_isa_path:
            ".claude-hooks/work/sid-1/ISA.md",
          expected_isa_path_absolute: path.join(
            cwd,
            ".claude-hooks/work/sid-1/ISA.md",
          ),
          // Classifier escalated mid-session to E4 — last_tier reflects
          // current classifier verdict, but engagement was frozen at E3.
          last_mode: "ALGORITHM",
          last_tier: 4,
          engagement_mode: "ALGORITHM",
          engagement_tier: 3,
        },
      })
      // Gate must NOT report a tier mismatch — ISA correctly matches the
      // frozen engagement tier.
      if (verdict._tag === "block") {
        expect(verdict.reason).not.toContain("classifier_tier expected")
      }
    } finally {
      cleanup()
    }
  })

  test("legacy record (no engagement_tier) falls back to last_tier", async () => {
    const { cwd, cleanup } = stage(ISA_E3)
    try {
      const verdict = checkStopReadiness({
        cwd,
        record: {
          engagement_required: true,
          expected_isa_path: ".claude-hooks/work/sid-1/ISA.md",
          expected_isa_path_absolute: path.join(
            cwd,
            ".claude-hooks/work/sid-1/ISA.md",
          ),
          last_mode: "ALGORITHM",
          last_tier: 3,
          // engagement_tier / engagement_mode intentionally omitted —
          // pretends to be a record written before the freeze fields
          // existed. Gate must still pass (legacy last_tier=3 matches
          // ISA's E3).
        },
      })
      expect(verdict._tag).toBe("noop")
    } finally {
      cleanup()
    }
  })

  test("real mismatch still blocks (ISA E3, frozen engagement_tier=4)", async () => {
    const { cwd, cleanup } = stage(ISA_E3)
    try {
      const verdict = checkStopReadiness({
        cwd,
        record: {
          engagement_required: true,
          expected_isa_path: ".claude-hooks/work/sid-1/ISA.md",
          expected_isa_path_absolute: path.join(
            cwd,
            ".claude-hooks/work/sid-1/ISA.md",
          ),
          last_mode: "ALGORITHM",
          last_tier: 4,
          engagement_mode: "ALGORITHM",
          engagement_tier: 4,
        },
      })
      expect(verdict._tag).toBe("block")
      if (verdict._tag === "block") {
        expect(verdict.reason).toContain("classifier_tier expected E4")
      }
    } finally {
      cleanup()
    }
  })

  test("path setup verifies stage exists", () => {
    // Sanity: smoke test for the test scaffolding.
    const { cwd, cleanup } = stage(ISA_E3)
    try {
      expect(
        existsSync(path.join(cwd, ".claude-hooks/work/sid-1/ISA.md")),
      ).toBe(true)
    } finally {
      cleanup()
    }
  })
})
