/**
 * P1.2 — handlePostToolUseIsaEffects must scope its probe target to the
 * session's expected ISA. A foreign-slug ISA under the session_root must
 * NOT be flipped by the current session's probe runner.
 *
 * FIXES: ISA-identity must be session-scoped.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handlePostToolUseIsaEffects } from "../../../src/algorithm/isa/lifecycle.ts"

const stage = (): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "chts-pte-identity-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const FOREIGN_ISA = `---
task: foreign
slug: old-slug
effort: advanced
phase: build
tier: E3
---

## Goal
foreign

## Criteria
- [ ] ISC-1: should not be flipped by the current session

## Test Strategy
| isc   | type | check | threshold | tool       |
|-------|------|-------|-----------|------------|
| ISC-1 | bun  | smoke | n/a       | tests-pass |
`

describe("handlePostToolUseIsaEffects — session-scoped ISA identity", () => {
  test("does not flip foreign-slug ISA when the session's expected ISA is missing", async () => {
    const { root, cleanup } = stage()
    try {
      // Probes registry — declares the probe used in the foreign ISA so that,
      // if the runner mistakenly targets it, ISC-1 would flip.
      mkdirSync(join(root, ".claude-hooks"), { recursive: true })
      writeFileSync(
        join(root, ".claude-hooks", "probes.ts"),
        'export const probes = { "tests-pass": async () => true }\n',
      )
      // Foreign-slug ISA exists under session_root, but is NOT the current session's ISA.
      const foreignDir = join(root, ".claude-hooks", "work", "old-slug")
      mkdirSync(foreignDir, { recursive: true })
      const foreignIsa = join(foreignDir, "ISA.md")
      writeFileSync(foreignIsa, FOREIGN_ISA, "utf-8")

      // Current session expects its own ISA at a different slug — not on disk.
      const expectedAbs = join(root, ".claude-hooks", "work", "current-slug", "ISA.md")
      const record = {
        engagement_required: true,
        expected_isa_path_absolute: expectedAbs,
        expected_isa_path: ".claude-hooks/work/current-slug/ISA.md",
      } as const

      // Call the lifecycle helper directly with the session record so the
      // resolver can scope the lookup. Current (buggy) main accepts only cwd
      // and would walk findLatestISA(root) → pick up the foreign ISA.
      await Effect.runPromise(
        handlePostToolUseIsaEffects(root, record),
      )

      const after = readFileSync(foreignIsa, "utf-8")
      // Foreign ISC-1 must still be unchecked.
      expect(after).toContain("- [ ] ISC-1")
      expect(after).not.toContain("- [x] ISC-1")
    } finally {
      cleanup()
    }
  })
})
