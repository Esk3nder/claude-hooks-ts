/**
 * Stop ISA-completeness gate (slice 2d).
 *
 * Asserts the new ISA-aware branch in `events/stop-definition-of-done.ts`:
 * if a project ISA at <cwd>/ISA.md or task ISA under <cwd>/.claude-hooks/work/{slug}/
 * (or the legacy <cwd>/.claude-hooks/state/work/{slug}/ — these tests still
 * write to the legacy path to exercise the backward-compatible read path)
 * declares `phase: complete` but the Tier Completeness Gate (IsaFormat.md:191-201)
 * or the criteria-checked count says otherwise, Stop is BLOCKED with a
 * model-actionable reason.
 *
 * Also asserts the engagement absence-is-failure gate: if the prompt-router
 * marked `engagement_required: true` (ALGORITHM E3+) and Stop fires without
 * any ISA on disk, the run is blocked once with a directive to scaffold the
 * ISA at the deterministic path the directive promised.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleStop } from "../../src/events/stop-definition-of-done.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import {
  SessionStateTest,
  EMPTY_SESSION_STATE,
  type SessionStateRecord,
} from "../../src/services/session-state.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const stage = (): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "chts-stopgate-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const writeProjectIsa = (root: string, content: string): void => {
  writeFileSync(join(root, "ISA.md"), content, "utf-8")
}

const writeTaskIsa = (root: string, slug: string, content: string): void => {
  const dir = join(root, ".claude-hooks", "state", "work", slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "ISA.md"), content, "utf-8")
}

const runStop = async (
  cwd: string,
  initial: Partial<SessionStateRecord> = {},
): Promise<{ decision?: string; reason?: string }> => {
  const sessionId = "test-stop"
  const seed = new Map([[sessionId, { ...EMPTY_SESSION_STATE, ...initial }]])
  const payload = decode({
    _tag: "Stop",
    session_id: sessionId,
    hook_event_name: "Stop",
    cwd,
  })
  const decision = await Effect.runPromise(
    handleStop(payload).pipe(Effect.provide(SessionStateTest(seed))),
  )
  return decision as { decision?: string; reason?: string }
}

const E1_COMPLETE_OK = `---
task: x
slug: 20260509_x
effort: standard
phase: complete
progress: 1/1
mode: interactive
started: 2026-05-09T00:00:00Z
updated: 2026-05-09T00:00:00Z
---

## Goal
ship

## Criteria
- [x] ISC-1: did the thing
`

const E1_COMPLETE_UNCHECKED = `---
task: x
slug: 20260509_x
effort: standard
phase: complete
progress: 0/1
mode: interactive
started: 2026-05-09T00:00:00Z
updated: 2026-05-09T00:00:00Z
---

## Goal
ship

## Criteria
- [ ] ISC-1: still pending
`

const E3_COMPLETE_MISSING_SECTIONS = `---
task: x
slug: 20260509_x
effort: advanced
phase: complete
progress: 1/1
mode: interactive
started: 2026-05-09T00:00:00Z
updated: 2026-05-09T00:00:00Z
---

## Goal
ship

## Criteria
- [x] ISC-1: did
`

const E3_COMPLETE_OK = `---
task: x
slug: 20260509_x
effort: advanced
phase: complete
progress: 1/1
mode: interactive
started: 2026-05-09T00:00:00Z
updated: 2026-05-09T00:00:00Z
---

## Problem
broken

## Vision
fixed

## Out of Scope
not refactoring

## Constraints
backward-compat

## Goal
ship

## Criteria
- [x] ISC-1: did

## Test Strategy
isc-1 | bash | smoke | n/a | bash

## Features
feat-a | ISC-1 | none | yes
`

const PHASE_BUILD_INCOMPLETE = `---
task: x
slug: 20260509_x
effort: standard
phase: build
progress: 0/1
mode: interactive
started: 2026-05-09T00:00:00Z
updated: 2026-05-09T00:00:00Z
---

## Goal
ship

## Criteria
- [ ] ISC-1: not done
`

describe("Stop ISA gate — completeness check on phase: complete", () => {
  test("no ISA at cwd → Stop proceeds (gate is opt-in via presence)", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runStop(root)
      expect(out).toEqual({})
    } finally {
      cleanup()
    }
  })

  test("E1 task ISA complete + all ISCs checked → Stop proceeds", async () => {
    const { root, cleanup } = stage()
    try {
      // Task ISA (no project-ISA tier flooring) → E1 stays E1.
      writeTaskIsa(root, "20260509_e1ok", E1_COMPLETE_OK)
      const out = await runStop(root)
      expect(out).toEqual({})
    } finally {
      cleanup()
    }
  })

  test("E1 task ISA phase: complete with unchecked ISC → BLOCK on count gate", async () => {
    const { root, cleanup } = stage()
    try {
      // Task ISA so E1 declared tier holds → tier gate passes (Goal+Criteria
      // present), count gate fires on the unchecked ISC.
      writeTaskIsa(root, "20260509_e1unc", E1_COMPLETE_UNCHECKED)
      const out = await runStop(root)
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("phase: complete")
      expect(out.reason ?? "").toContain("ISC criteria")
    } finally {
      cleanup()
    }
  })

  test("E1 PROJECT ISA → tier floors to E3, blocks for missing sections", async () => {
    const { root, cleanup } = stage()
    try {
      // Project ISAs are doctrine-floored to E3 (IsaFormat.md:201).
      // An E1-shaped project ISA must therefore fail the Tier Completeness Gate.
      writeProjectIsa(root, E1_COMPLETE_OK)
      const out = await runStop(root)
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("Tier Completeness Gate")
      expect(out.reason ?? "").toContain("E3")
    } finally {
      cleanup()
    }
  })

  test("E3 ISA missing required sections (Vision/Out of Scope/Features/Test Strategy/...) → BLOCK", async () => {
    const { root, cleanup } = stage()
    try {
      // Project ISAs are tier-floored to 3, so writing as a project ISA
      // forces E3 even if effort were lower.
      writeProjectIsa(root, E3_COMPLETE_MISSING_SECTIONS)
      const out = await runStop(root)
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("Tier Completeness Gate")
      // Missing sections from E3's required set — at least one must be named.
      expect(out.reason ?? "").toMatch(
        /Vision|Out of Scope|Test Strategy|Features|Constraints|Problem/,
      )
    } finally {
      cleanup()
    }
  })

  test("E3 ISA fully complete → Stop proceeds", async () => {
    const { root, cleanup } = stage()
    try {
      writeProjectIsa(root, E3_COMPLETE_OK)
      const out = await runStop(root)
      expect(out).toEqual({})
    } finally {
      cleanup()
    }
  })

  test("ISA phase: build (not complete) → gate doesn't fire", async () => {
    const { root, cleanup } = stage()
    try {
      writeProjectIsa(root, PHASE_BUILD_INCOMPLETE)
      const out = await runStop(root)
      expect(out).toEqual({})
    } finally {
      cleanup()
    }
  })

  test("task ISA is consulted when no project ISA exists", async () => {
    const { root, cleanup } = stage()
    try {
      writeTaskIsa(root, "20260509_t", E1_COMPLETE_UNCHECKED)
      const out = await runStop(root)
      expect(out.decision).toBe("block")
    } finally {
      cleanup()
    }
  })

  test("project ISA wins when both project and task ISAs exist", async () => {
    const { root, cleanup } = stage()
    try {
      // Project ISA is healthy E3-complete; task ISA is broken. Gate looks
      // at project ISA first, finds it OK, doesn't fall through to task ISA.
      writeProjectIsa(root, E3_COMPLETE_OK)
      writeTaskIsa(root, "20260509_t", E1_COMPLETE_UNCHECKED)
      const out = await runStop(root)
      expect(out).toEqual({})
    } finally {
      cleanup()
    }
  })

  test("loop-protection: a session that already blocked once gets through", async () => {
    const { root, cleanup } = stage()
    try {
      writeProjectIsa(root, E1_COMPLETE_UNCHECKED)
      const out = await runStop(root, { stop_blocked_once: true })
      expect(out).toEqual({})
    } finally {
      cleanup()
    }
  })

  test("ISA gate runs BEFORE research-mode gate (block reason mentions ISA, not source ledger)", async () => {
    const { root, cleanup } = stage()
    try {
      writeProjectIsa(root, E1_COMPLETE_UNCHECKED)
      const out = await runStop(root, {
        last_workflow: "research.web", // would otherwise trigger research-mode gate
      })
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("ISA")
      expect(out.reason ?? "").not.toContain("source ledger")
    } finally {
      cleanup()
    }
  })

  test("ISA gate runs BEFORE files-changed verification gate", async () => {
    const { root, cleanup } = stage()
    try {
      writeProjectIsa(root, E1_COMPLETE_UNCHECKED)
      const out = await runStop(root, {
        files_changed: ["a.ts", "b.ts"],
        verification_status: "none",
      })
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("ISA")
      expect(out.reason ?? "").not.toContain("verification command")
    } finally {
      cleanup()
    }
  })

  test("malformed frontmatter (no fm at all) → gate skipped, falls through to existing gates", async () => {
    const { root, cleanup } = stage()
    try {
      writeProjectIsa(
        root,
        "## Goal\nno frontmatter\n## Criteria\n- [ ] ISC-1: x\n",
      )
      // No frontmatter → gate noops → falls through. Verification gate fires
      // because files_changed > 0 + verification_status != passed.
      const out = await runStop(root, {
        files_changed: ["a.ts"],
        verification_status: "none",
      })
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("verification command") // existing gate, not ISA
    } finally {
      cleanup()
    }
  })

  test("phase value is case-insensitive (tolerance)", async () => {
    const { root, cleanup } = stage()
    try {
      writeProjectIsa(
        root,
        E1_COMPLETE_UNCHECKED.replace("phase: complete", "phase: COMPLETE"),
      )
      const out = await runStop(root)
      expect(out.decision).toBe("block")
    } finally {
      cleanup()
    }
  })

  test("redteam: TaskCompleted-without-evidence pattern — phase complete + 0/N progress → BLOCK", async () => {
    const { root, cleanup } = stage()
    try {
      const isa = `---
task: ship the auth refactor
slug: 20260509_auth
effort: advanced
phase: complete
progress: 0/3
mode: interactive
started: 2026-05-09T00:00:00Z
updated: 2026-05-09T00:00:00Z
---

## Problem
broken

## Vision
fixed

## Out of Scope
not the world

## Constraints
keep API

## Goal
ship

## Criteria
- [ ] ISC-1: not done
- [ ] ISC-2: not done
- [ ] ISC-3: not done

## Test Strategy
isc-1 | bash | x | x | x

## Features
feat | ISC-1 | none | yes
`
      writeProjectIsa(root, isa)
      const out = await runStop(root)
      expect(out.decision).toBe("block")
      // The completeness gate fires first since project ISAs are floored to E3
      // and this E3 has all sections — actually it's the count gate that fires.
      // Either way, block reason must mention the criteria gap.
      expect(out.reason ?? "").toMatch(/ISC|criteria|Completeness/i)
    } finally {
      cleanup()
    }
  })
})

describe("Stop engagement absence-is-failure gate", () => {
  test("engagement_required + no ISA on disk → block once with directive to scaffold", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runStop(root, {
        engagement_required: true,
        last_mode: "ALGORITHM",
        last_tier: 3,
        expected_isa_path: ".claude-hooks/work/test-stop/ISA.md",
      })
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("ALGORITHM E3")
      expect(out.reason ?? "").toContain(
        ".claude-hooks/work/test-stop/ISA.md",
      )
      expect(out.reason ?? "").toMatch(/Goal|Criteria/)
    } finally {
      cleanup()
    }
  })

  test("engagement_required + project ISA exists → gate does NOT fire (presence satisfies)", async () => {
    const { root, cleanup } = stage()
    try {
      const minimalIsa = `---\neffort: advanced\nphase: observe\n---\n\n## Goal\nx\n\n## Criteria\n- [ ] ISC-1: tbd\n`
      writeProjectIsa(root, minimalIsa)
      const out = await runStop(root, {
        engagement_required: true,
        last_mode: "ALGORITHM",
        last_tier: 3,
        expected_isa_path: ".claude-hooks/work/test-stop/ISA.md",
      })
      // Phase is `observe`, not `complete`, so the completeness gate noops too.
      // The engagement gate must accept the project ISA as satisfaction.
      expect(out).toEqual({})
    } finally {
      cleanup()
    }
  })

  test("engagement_required + task ISA exists at deterministic path → gate does NOT fire", async () => {
    const { root, cleanup } = stage()
    try {
      const minimalIsa = `---\neffort: advanced\nphase: observe\n---\n\n## Goal\nx\n\n## Criteria\n- [ ] ISC-1: tbd\n`
      writeTaskIsa(root, "20260510_some_task", minimalIsa)
      const out = await runStop(root, {
        engagement_required: true,
        last_mode: "ALGORITHM",
        last_tier: 4,
        expected_isa_path: ".claude-hooks/work/test-stop/ISA.md",
      })
      expect(out).toEqual({})
    } finally {
      cleanup()
    }
  })

  test("engagement_required=false → gate is inert even with no ISA", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runStop(root, {
        engagement_required: false,
        last_mode: "NATIVE",
      })
      expect(out).toEqual({})
    } finally {
      cleanup()
    }
  })

  test("engagement_required + no ISA + stop_blocked_once → does NOT block (loop guard)", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runStop(root, {
        engagement_required: true,
        last_mode: "ALGORITHM",
        last_tier: 3,
        expected_isa_path: ".claude-hooks/work/test-stop/ISA.md",
        stop_blocked_once: true,
      })
      expect(out).toEqual({})
    } finally {
      cleanup()
    }
  })
})
