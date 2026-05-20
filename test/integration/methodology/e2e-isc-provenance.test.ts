/**
 * Methodology pillar: ISC checkbox probe-provenance (US-14).
 *
 * The promise: when an ISA's Test Strategy declares `requires_probe: true`
 * for a criterion, the Stop completeness gate refuses to accept the
 * checkbox as "satisfied" unless `session-state.probe_verified_iscs`
 * records that the flip came from a probe pass (not a model Edit).
 *
 * Direct test of `checkStopReadiness` — the Stop handler façade — so we
 * can assert the block reason without standing up the full hook protocol.
 */
import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { checkStopReadiness } from "../../../src/algorithm/isa/lifecycle.ts"
import { EMPTY_SESSION_STATE } from "../../../src/services/session-state.ts"
import { engagedPatch, withTmpProject } from "./_helpers.ts"

const ISA_REQUIRES_PROBE = `---
effort: advanced
phase: complete
classifier_mode: ALGORITHM
classifier_tier: E3
classifier_reason: methodology fixture
---

## Problem
x

## Vision
y

## Out of Scope
none

## Constraints
none

## Goal
ship

## Criteria
- [x] ISC-1: do the thing

## Features
- one

## Test Strategy
| isc | tool | requires_probe |
|---|---|---|
| ISC-1 | typecheck | true |
`

describe("methodology e2e: ISC probe-provenance (US-14)", () => {
  test("requires_probe=true + ISC checked but NOT in probe_verified_iscs → block", () => {
    const project = withTmpProject("prov-1")
    try {
      const sessionId = "prov-1"
      const isaPath = path.join(project.root, ".claude-hooks", "work", sessionId, "ISA.md")
      fs.mkdirSync(path.dirname(isaPath), { recursive: true })
      fs.writeFileSync(isaPath, ISA_REQUIRES_PROBE, "utf-8")
      const verdict = checkStopReadiness({
        cwd: project.root,
        record: {
          ...EMPTY_SESSION_STATE,
          ...engagedPatch(project.root, sessionId, 3),
          probe_verified_iscs: [], // model flipped the box, no probe pass recorded
        },
      })
      expect(verdict._tag).toBe("block")
      if (verdict._tag === "block") {
        expect(verdict.reason).toContain("ISC-1")
        expect(verdict.reason).toContain("provenance")
      }
    } finally {
      project.cleanup()
    }
  })

  test("requires_probe=true + ISC checked AND in probe_verified_iscs → noop (release)", () => {
    const project = withTmpProject("prov-2")
    try {
      const sessionId = "prov-2"
      const isaPath = path.join(project.root, ".claude-hooks", "work", sessionId, "ISA.md")
      fs.mkdirSync(path.dirname(isaPath), { recursive: true })
      fs.writeFileSync(isaPath, ISA_REQUIRES_PROBE, "utf-8")
      const verdict = checkStopReadiness({
        cwd: project.root,
        record: {
          ...EMPTY_SESSION_STATE,
          ...engagedPatch(project.root, sessionId, 3),
          probe_verified_iscs: ["ISC-1"], // probe pass recorded
        },
      })
      expect(verdict._tag).toBe("noop")
    } finally {
      project.cleanup()
    }
  })
})
