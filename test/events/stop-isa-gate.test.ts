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

const writeCanonicalTaskIsa = (root: string, slug: string, content: string): void => {
  const dir = join(root, ".claude-hooks", "work", slug)
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

const E3_ENGAGED_COMPLETE_OK = `---
task: x
slug: test-stop
effort: advanced
phase: complete
progress: 1/1
mode: interactive
classifier_mode: ALGORITHM
classifier_tier: E3
classifier_reason: test e3
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

## Verification
- ISC-1: passed smoke
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

const E3_OBSERVE_PENDING = `---
task: solar dashboard
slug: test-stop
effort: advanced
phase: observe
progress: 0/1
mode: interactive
classifier_mode: ALGORITHM
classifier_tier: E3
classifier_reason: test e3
started: 2026-05-09T00:00:00Z
updated: 2026-05-09T00:00:00Z
---

## Problem
needs a finance dashboard

## Vision
source-backed local tool

## Out of Scope
server

## Constraints
self-contained html

## Goal
ship

## Criteria
- [ ] ISC-1: source-backed dashboard verified

## Test Strategy
ISC-1 | browser | smoke | n/a | open html

## Features
dashboard | ISC-1 | none | yes

## Verification
- pending
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

  // T1.4 — the canonical `tier: E<N>` frontmatter shape was previously
  // ignored by the gate (tierFromEffort only recognized `effort:` codes
  // like "advanced"). With no recognized tier, checkCompleteness was
  // skipped entirely on every ISA following the documented format —
  // half of the gate was dead code on the canonical shape.
  test("E3 task ISA with `tier: E3` frontmatter and missing sections → BLOCK", async () => {
    const { root, cleanup } = stage()
    try {
      writeTaskIsa(
        root,
        "20260509_tier",
        `---
task: x
slug: 20260509_tier
tier: E3
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
`,
      )
      const out = await runStop(root)
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("Tier Completeness Gate")
      expect(out.reason ?? "").toContain("E3")
    } finally {
      cleanup()
    }
  })

  test("E3 task ISA with `tier: 3` (numeric form) and missing sections → BLOCK", async () => {
    const { root, cleanup } = stage()
    try {
      writeTaskIsa(
        root,
        "20260509_tn",
        `---
task: x
slug: 20260509_tn
tier: 3
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
`,
      )
      const out = await runStop(root)
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("Tier Completeness Gate")
    } finally {
      cleanup()
    }
  })

  // Boundary tests for tierFromTier — pin the regex for E0/E6/lowercase/
  // garbage values. parseTier silently falls back to tierFromEffort when
  // `tier:` is unrecognized; if both fields are missing/garbage, the
  // tier-completeness arm is skipped (count gate may still fire).
  test("`tier: E0` is unrecognized → tier gate skipped (count gate may still fire)", async () => {
    const { root, cleanup } = stage()
    try {
      writeTaskIsa(
        root,
        "20260509_t0",
        `---
task: x
slug: 20260509_t0
tier: E0
phase: complete
progress: 0/1
mode: interactive
started: 2026-05-09T00:00:00Z
updated: 2026-05-09T00:00:00Z
---

## Goal
ship

## Criteria
- [ ] ISC-1: not done
`,
      )
      const out = await runStop(root)
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("ISC criteria")
      expect(out.reason ?? "").not.toContain("Tier Completeness Gate")
    } finally {
      cleanup()
    }
  })

  test("`tier: E6` (out of range) is unrecognized → tier gate skipped", async () => {
    const { root, cleanup } = stage()
    try {
      writeTaskIsa(
        root,
        "20260509_t6",
        `---
task: x
slug: 20260509_t6
tier: E6
phase: complete
progress: 0/1
mode: interactive
started: 2026-05-09T00:00:00Z
updated: 2026-05-09T00:00:00Z
---

## Goal
ship

## Criteria
- [ ] ISC-1: not done
`,
      )
      const out = await runStop(root)
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("ISC criteria")
      expect(out.reason ?? "").not.toContain("Tier Completeness Gate")
    } finally {
      cleanup()
    }
  })

  test("invalid `tier:` falls back to `effort:` when present", async () => {
    const { root, cleanup } = stage()
    try {
      // `tier: garbage` → tierFromTier returns null. `effort: advanced`
      // takes over → tier 3. Project ISA → floor stays 3 → block on
      // missing E3 sections.
      writeProjectIsa(
        root,
        `---
task: x
slug: 20260509_fallback
tier: garbage
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
`,
      )
      const out = await runStop(root)
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("Tier Completeness Gate")
    } finally {
      cleanup()
    }
  })

  test("when `tier:` and `effort:` disagree, canonical `tier:` wins", async () => {
    const { root, cleanup } = stage()
    try {
      // `tier: E1` says E1; `effort: comprehensive` says E5. Canonical wins → E1.
      // Task ISA → E1 stays E1 (no project floor). Phase complete + all ISCs
      // checked + Goal+Criteria present → completeness passes at E1.
      // If `effort:` had won (E5), this would block on missing E5 sections.
      writeTaskIsa(
        root,
        "20260509_disagree",
        `---
task: x
slug: 20260509_disagree
tier: E1
effort: comprehensive
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
`,
      )
      const out = await runStop(root)
      expect(out).toEqual({})
    } finally {
      cleanup()
    }
  })

  test("`tier: e3` (lowercase prefix) is recognized same as `tier: E3`", async () => {
    const { root, cleanup } = stage()
    try {
      writeTaskIsa(
        root,
        "20260509_lower",
        `---
task: x
slug: 20260509_lower
tier: e3
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
`,
      )
      const out = await runStop(root)
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("Tier Completeness Gate")
    } finally {
      cleanup()
    }
  })

  test("`tier:` and `effort:` agree → uses one consistent tier (no double-fire)", async () => {
    const { root, cleanup } = stage()
    try {
      // Both fields present, both name E1. Should still block as PROJECT-ISA
      // floor of 3 (consistent with the existing E1 PROJECT ISA test).
      writeProjectIsa(
        root,
        `---
task: x
slug: 20260509_both
tier: E1
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
- [x] ISC-1: did
`,
      )
      const out = await runStop(root)
      expect(out.decision).toBe("block")
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

  test("ISA gate bundles files-changed verification reminder on first block", async () => {
    const { root, cleanup } = stage()
    try {
      writeProjectIsa(root, E1_COMPLETE_UNCHECKED)
      const out = await runStop(root, {
        files_changed: ["a.ts", "b.ts"],
        verification_status: "none",
      })
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("ISA")
      expect(out.reason ?? "").toContain("verification command")
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

  test("engagement_required + no ISA + read-only smoke commands only → does NOT block", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runStop(root, {
        engagement_required: true,
        last_mode: "ALGORITHM",
        last_tier: 3,
        expected_isa_path: ".claude-hooks/work/test-stop/ISA.md",
        commands_run: [
          "pwd",
          "rg -n \"runGitApply|applyWorkerPatch\" src/services/worker-integration.ts",
          "./bin/claude-hooks-workers list --json",
        ],
        subagent_starts: ["explore-agent"],
        subagent_stops: ["explore-agent"],
      })
      expect(out).toEqual({})
    } finally {
      cleanup()
    }
  })

  test("engagement_required + no ISA + read-only smoke command with chaining → blocks", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runStop(root, {
        engagement_required: true,
        last_mode: "ALGORITHM",
        last_tier: 3,
        expected_isa_path: ".claude-hooks/work/test-stop/ISA.md",
        commands_run: ["rg foo src && rm -rf /"],
      })
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("ALGORITHM E3")
    } finally {
      cleanup()
    }
  })

  test("engagement_required + no ISA + rg preprocessor command → blocks", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runStop(root, {
        engagement_required: true,
        last_mode: "ALGORITHM",
        last_tier: 3,
        expected_isa_path: ".claude-hooks/work/test-stop/ISA.md",
        commands_run: ["rg --pre 'python3 -c \"print(1)\"' needle src"],
      })
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("ALGORITHM E3")
    } finally {
      cleanup()
    }
  })

  test("engagement_required + no ISA + write-worker contract start → blocks", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runStop(root, {
        engagement_required: true,
        last_mode: "ALGORITHM",
        last_tier: 3,
        expected_isa_path: ".claude-hooks/work/test-stop/ISA.md",
        commands_run: ["pwd"],
        subagent_starts: ["worker-agent", "worker-agent:worker-contract"],
      })
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("ALGORITHM E3")
    } finally {
      cleanup()
    }
  })

  test("engagement_required + no ISA + file changes → blocks even with inspection commands", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runStop(root, {
        engagement_required: true,
        last_mode: "ALGORITHM",
        last_tier: 3,
        expected_isa_path: ".claude-hooks/work/test-stop/ISA.md",
        commands_run: ["pwd"],
        files_changed: [join(root, "src", "changed.ts")],
      })
      expect(out.decision).toBe("block")
    } finally {
      cleanup()
    }
  })

  test("engagement_required + complete project ISA exists → gate does NOT fire", async () => {
    const { root, cleanup } = stage()
    try {
      writeProjectIsa(root, E3_ENGAGED_COMPLETE_OK)
      const out = await runStop(root, {
        engagement_required: true,
        last_mode: "ALGORITHM",
        last_tier: 3,
        expected_isa_path: ".claude-hooks/work/test-stop/ISA.md",
      })
      expect(out).toEqual({})
    } finally {
      cleanup()
    }
  })

  // FIXES: ISA-identity must be session-scoped.
  // Previously this test passed when ANY task ISA existed under session_root,
  // regardless of slug. That meant a stale foreign-slug ISA could satisfy
  // the engagement gate. Now the gate only accepts the session's own
  // expected ISA (or a project ISA).
  test("engagement_required + complete task ISA at expected path → gate does NOT fire", async () => {
    const { root, cleanup } = stage()
    try {
      // Write the ISA at the slug the session expects (canonical path), not a foreign slug.
      writeCanonicalTaskIsa(root, "test-stop", E3_ENGAGED_COMPLETE_OK)
      const out = await runStop(root, {
        engagement_required: true,
        last_mode: "ALGORITHM",
        last_tier: 3,
        expected_isa_path: ".claude-hooks/work/test-stop/ISA.md",
        expected_isa_path_absolute: join(
          root,
          ".claude-hooks",
          "work",
          "test-stop",
          "ISA.md",
        ),
      })
      expect(out).toEqual({})
    } finally {
      cleanup()
    }
  })

  // FIXES: ISA-identity must be session-scoped.
  // A foreign-slug ISA under session_root must NOT satisfy the engagement.
  test("engagement_required + foreign-slug task ISA only → BLOCK (identity scoping)", async () => {
    const { root, cleanup } = stage()
    try {
      const minimalIsa = `---\neffort: advanced\nphase: observe\n---\n\n## Goal\nx\n\n## Criteria\n- [ ] ISC-1: tbd\n`
      writeTaskIsa(root, "20260510_some_task", minimalIsa)
      const out = await runStop(root, {
        engagement_required: true,
        last_mode: "ALGORITHM",
        last_tier: 4,
        expected_isa_path: ".claude-hooks/work/test-stop/ISA.md",
        expected_isa_path_absolute: join(
          root,
          ".claude-hooks",
          "work",
          "test-stop",
          "ISA.md",
        ),
      })
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("test-stop")
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

  // P2a — Stop absence reason names the absolute ISA path so the model
  // can write unambiguously even when the shell cwd has drifted since
  // engagement.
  test("absence reason includes the absolute expected-ISA path when state has one", async () => {
    const { root, cleanup } = stage()
    try {
      const absolutePath =
        "/some/absolute/path/.claude-hooks/work/test-stop/ISA.md"
      const out = await runStop(root, {
        engagement_required: true,
        last_mode: "ALGORITHM",
        last_tier: 3,
        expected_isa_path: ".claude-hooks/work/test-stop/ISA.md",
        expected_isa_path_absolute: absolutePath,
      })
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain(
        ".claude-hooks/work/test-stop/ISA.md",
      )
      expect(out.reason ?? "").toContain(absolutePath)
    } finally {
      cleanup()
    }
  })

  test("engagement_required + own ISA still phase: observe → blocks before final", async () => {
    const { root, cleanup } = stage()
    try {
      writeCanonicalTaskIsa(root, "test-stop", E3_OBSERVE_PENDING)
      const out = await runStop(root, {
        engagement_required: true,
        last_mode: "ALGORITHM",
        last_tier: 3,
        expected_isa_path: ".claude-hooks/work/test-stop/ISA.md",
      })
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("phase: observe")
      expect(out.reason ?? "").toContain("phase: complete")
      expect(out.reason ?? "").toContain("Verification")
    } finally {
      cleanup()
    }
  })

  test("source-backed engaged feature with pending ISA reports all first-stop blockers together", async () => {
    const { root, cleanup } = stage()
    try {
      writeCanonicalTaskIsa(root, "test-stop", E3_OBSERVE_PENDING)
      const out = await runStop(root, {
        engagement_required: true,
        last_mode: "ALGORITHM",
        last_tier: 3,
        expected_isa_path: ".claude-hooks/work/test-stop/ISA.md",
        last_workflow: "coding.feature",
        requires_web_sources: true,
        files_changed: ["solar-underwriting.html"],
        verification_status: "none",
      })
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("phase: observe")
      expect(out.reason ?? "").toMatch(/source ledger/i)
      expect(out.reason ?? "").toContain("verification command")
    } finally {
      cleanup()
    }
  })
})
