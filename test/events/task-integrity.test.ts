import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  handleTaskCreated,
  handleTaskCompleted as handleTaskCompletedRaw,
} from "../../src/events/task-integrity.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import {
  SessionStateTest,
  EMPTY_SESSION_STATE,
} from "../../src/services/session-state.ts"

// Test isolation: tests that don't pin `cwd` on the payload would
// otherwise default to `process.cwd()` for ISA discovery, which picks up
// whatever real-world ISA happens to live under the repo's
// `.claude-hooks/work/` directory. To keep the AC/evidence-focused tests
// hermetic, the wrapper seeds `session_root` to an empty tmpdir ONLY
// when the payload has no explicit `cwd`. Tests that pass `cwd` (the
// ISA-discovery suite below) continue to drive the handler with their
// own staged directory.
const ISOLATED_ROOT = mkdtempSync(join(tmpdir(), "chts-ti-isolated-"))

const isolatedSessionState = (sessionId: string) =>
  SessionStateTest(
    new Map([
      [
        sessionId,
        { ...EMPTY_SESSION_STATE, session_root: ISOLATED_ROOT },
      ],
    ]),
  )

const handleTaskCompleted = (
  p: Parameters<typeof handleTaskCompletedRaw>[0],
  sessionStateLayer?: ReturnType<typeof SessionStateTest>,
) => {
  const payloadCwd =
    typeof (p as { cwd?: unknown }).cwd === "string" &&
    (p as { cwd: string }).cwd.length > 0
  const layer =
    sessionStateLayer ??
    (payloadCwd
      ? SessionStateTest()
      : isolatedSessionState((p as { session_id: string }).session_id))
  return handleTaskCompletedRaw(p).pipe(Effect.provide(layer))
}

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const stage = (): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "chts-task-integ-"))
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

const ISA_UNCHECKED = `---
task: x
slug: 20260509_x
phase: build
---

## Goal
ship

## Criteria
- [ ] ISC-1: still pending
`

const ISA_ALL_CHECKED_NO_VERIFICATION = `---
task: x
slug: 20260509_x
phase: build
---

## Goal
ship

## Criteria
- [x] ISC-1: did the thing
- [x] ISC-2: did the other
`

const ISA_ALL_CHECKED_WITH_VERIFICATION = `---
task: x
slug: 20260509_x
phase: build
---

## Goal
ship

## Criteria
- [x] ISC-1: did

## Verification
- ISC-1: bun test passes 14/14
`

describe("VAL-M4-004 task-integrity", () => {
  test("TaskCreated is advisory (never blocks)", async () => {
    const p = decode({
      _tag: "TaskCreated",
      session_id: "s",
      hook_event_name: "TaskCreated",
      task_id: "t1",
      description: "x",
    })
    const d = await Effect.runPromise(handleTaskCreated(p))
    expect(d).toEqual({})
  })

  test("TaskCompleted missing acceptance_criteria → block", async () => {
    const p = decode({
      _tag: "TaskCompleted",
      session_id: "s",
      hook_event_name: "TaskCompleted",
      task_id: "t1",
      status: "ok",
    })
    const d = await Effect.runPromise(handleTaskCompleted(p))
    expect("decision" in d).toBe(true)
    if ("decision" in d) {
      expect(d.decision).toBe("block")
      expect(d.reason).toContain("acceptance_criteria")
    }
  })

  test("TaskCompleted missing evidence → block", async () => {
    const p = decode({
      _tag: "TaskCompleted",
      session_id: "s",
      hook_event_name: "TaskCompleted",
      task_id: "t1",
      acceptance_criteria: "All tests pass",
      evidence: [],
    })
    const d = await Effect.runPromise(handleTaskCompleted(p))
    if ("decision" in d) {
      expect(d.decision).toBe("block")
    }
  })

  test("TaskCompleted with both fields → no-op", async () => {
    const p = decode({
      _tag: "TaskCompleted",
      session_id: "s",
      hook_event_name: "TaskCompleted",
      task_id: "t1",
      acceptance_criteria: "Tests pass and CI green",
      evidence: ["bun test exit 0", "ci run #123 green"],
    })
    const d = await Effect.runPromise(handleTaskCompleted(p))
    expect(d).toEqual({})
  })
})

describe("3c — TaskCompleted ISC-evidence requirement", () => {
  test("no ISA at cwd → existing field-check behavior preserved (no-op when fields present)", async () => {
    const { root, cleanup } = stage()
    try {
      const p = decode({
        _tag: "TaskCompleted",
        session_id: "s",
        hook_event_name: "TaskCompleted",
        task_id: "t1",
        acceptance_criteria: "Tests pass",
        evidence: ["bun test exit 0"],
        cwd: root,
      })
      expect(await Effect.runPromise(handleTaskCompleted(p))).toEqual({})
    } finally {
      cleanup()
    }
  })

  test("project ISA with unchecked ISCs → BLOCK with ISA-specific reason", async () => {
    const { root, cleanup } = stage()
    try {
      writeProjectIsa(root, ISA_UNCHECKED)
      const p = decode({
        _tag: "TaskCompleted",
        session_id: "s",
        hook_event_name: "TaskCompleted",
        task_id: "t1",
        acceptance_criteria: "Tests pass",
        evidence: ["evidence"],
        cwd: root,
      })
      const d = await Effect.runPromise(handleTaskCompleted(p))
      expect("decision" in d).toBe(true)
      if ("decision" in d) {
        expect(d.decision).toBe("block")
        expect(d.reason).toContain("ISA")
        expect(d.reason).toContain("unchecked")
      }
    } finally {
      cleanup()
    }
  })

  test("task ISA (no project ISA) consulted when present", async () => {
    const { root, cleanup } = stage()
    try {
      writeTaskIsa(root, "20260509_t", ISA_UNCHECKED)
      const p = decode({
        _tag: "TaskCompleted",
        session_id: "s",
        hook_event_name: "TaskCompleted",
        task_id: "t1",
        acceptance_criteria: "x",
        evidence: ["x"],
        cwd: root,
      })
      const d = await Effect.runPromise(handleTaskCompleted(p))
      if ("decision" in d) expect(d.decision).toBe("block")
    } finally {
      cleanup()
    }
  })

  test("ISA all-checked but Verification section empty → BLOCK with verification reason", async () => {
    const { root, cleanup } = stage()
    try {
      writeProjectIsa(root, ISA_ALL_CHECKED_NO_VERIFICATION)
      const p = decode({
        _tag: "TaskCompleted",
        session_id: "s",
        hook_event_name: "TaskCompleted",
        task_id: "t1",
        acceptance_criteria: "x",
        evidence: ["x"],
        cwd: root,
      })
      const d = await Effect.runPromise(handleTaskCompleted(p))
      if ("decision" in d) {
        expect(d.decision).toBe("block")
        expect(d.reason).toContain("Verification")
      }
    } finally {
      cleanup()
    }
  })

  test("ISA all-checked + Verification populated → no-op", async () => {
    const { root, cleanup } = stage()
    try {
      writeProjectIsa(root, ISA_ALL_CHECKED_WITH_VERIFICATION)
      const p = decode({
        _tag: "TaskCompleted",
        session_id: "s",
        hook_event_name: "TaskCompleted",
        task_id: "t1",
        acceptance_criteria: "x",
        evidence: ["x"],
        cwd: root,
      })
      const d = await Effect.runPromise(handleTaskCompleted(p))
      expect(d).toEqual({})
    } finally {
      cleanup()
    }
  })

  test("ISA gate fires BEFORE generic field-missing message (specific guidance wins)", async () => {
    const { root, cleanup } = stage()
    try {
      writeProjectIsa(root, ISA_UNCHECKED)
      // Missing acceptance_criteria — would normally trigger generic message.
      // ISA gate fires first because it's more specific.
      const p = decode({
        _tag: "TaskCompleted",
        session_id: "s",
        hook_event_name: "TaskCompleted",
        task_id: "t1",
        cwd: root,
      })
      const d = await Effect.runPromise(handleTaskCompleted(p))
      if ("decision" in d) {
        expect(d.decision).toBe("block")
        expect(d.reason).toContain("ISA")
        expect(d.reason).not.toContain("acceptance_criteria")
      }
    } finally {
      cleanup()
    }
  })

  test("malformed ISA (no Criteria section) → gate skipped, falls through to existing checks", async () => {
    const { root, cleanup } = stage()
    try {
      writeProjectIsa(
        root,
        `---\ntask: x\n---\n\n## Goal\nno criteria here\n`,
      )
      // No criteria → counts.total = 0 → ISA gate noops → existing fields check runs.
      const p = decode({
        _tag: "TaskCompleted",
        session_id: "s",
        hook_event_name: "TaskCompleted",
        task_id: "t1",
        cwd: root,
      })
      const d = await Effect.runPromise(handleTaskCompleted(p))
      if ("decision" in d) {
        expect(d.decision).toBe("block")
        expect(d.reason).toContain("acceptance_criteria")
      }
    } finally {
      cleanup()
    }
  })
})

// FIXES: ISA-identity must be session-scoped.
//
// P1.3 — TaskCompleted's ISA-evidence gate must scope its lookup to the
// session's expected ISA. A foreign-slug ISA under session_root must NOT
// be used as evidence-target for the current session. When the session's
// own expected ISA is absent, the gate is a no-op (Stop is the engaged
// absence gate; task-integrity should not double up on missing ISA).
describe("3c-identity — TaskCompleted ignores foreign-slug ISA", () => {
  test("foreign ISA under session_root + missing expected ISA + valid AC/evidence → no-op (no block citing foreign path)", async () => {
    const { root, cleanup } = stage()
    try {
      // Foreign-slug ISA with unchecked criteria — would trigger the gate
      // on current (buggy) main because checkIsaEvidence uses findLatestISA.
      writeTaskIsa(root, "old-slug", ISA_UNCHECKED)
      const expectedAbs = join(root, ".claude-hooks", "work", "current-slug", "ISA.md")
      const sessionId = "ti-identity"
      const layer = SessionStateTest(
        new Map([
          [
            sessionId,
            {
              ...EMPTY_SESSION_STATE,
              engagement_required: true,
              session_root: root,
              expected_isa_path: ".claude-hooks/work/current-slug/ISA.md",
              expected_isa_path_absolute: expectedAbs,
            },
          ],
        ]),
      )
      const p = decode({
        _tag: "TaskCompleted",
        session_id: sessionId,
        hook_event_name: "TaskCompleted",
        task_id: "t1",
        acceptance_criteria: "Tests pass",
        evidence: ["bun test exit 0"],
        cwd: root,
      })
      const d = await Effect.runPromise(handleTaskCompleted(p, layer))
      // Must NOT block citing the foreign ISA's path or "unchecked" criteria.
      if ("decision" in d) {
        // If anything blocks, it must not be the foreign-ISA gate.
        expect(d.reason ?? "").not.toContain("old-slug")
        expect(d.reason ?? "").not.toContain("unchecked")
      }
      // The AC+evidence are valid, so no-op is the expected outcome.
      expect(d).toEqual({})
    } finally {
      cleanup()
    }
  })
})

describe("metadata-fallback for AC/evidence (harness-bridge)", () => {
  // A — raw wire payload with metadata decodes (no _tag baked in)
  test("A: TaskCompleted raw wire payload with metadata decodes", () => {
    const p = decode({
      session_id: "s",
      hook_event_name: "TaskCompleted",
      task_id: "t1",
      metadata: {
        acceptance_criteria: "done means tests pass",
        evidence: ["bun test exit 0"],
      },
    })
    expect(p._tag).toBe("TaskCompleted")
  })

  // B — metadata fallback approves
  test("B: metadata.acceptance_criteria + metadata.evidence → no-op", async () => {
    const p = decode({
      session_id: "s",
      hook_event_name: "TaskCompleted",
      task_id: "t1",
      metadata: {
        acceptance_criteria: "Task is done when tests pass",
        evidence: ["bun test exit 0"],
      },
    })
    const d = await Effect.runPromise(handleTaskCompleted(p))
    expect(d).toEqual({})
  })

  // C — top-level still approves (regression check on existing behavior)
  test("C: top-level acceptance_criteria + evidence → no-op", async () => {
    const p = decode({
      session_id: "s",
      hook_event_name: "TaskCompleted",
      task_id: "t1",
      acceptance_criteria: "Task is done",
      evidence: ["evidence-1"],
    })
    const d = await Effect.runPromise(handleTaskCompleted(p))
    expect(d).toEqual({})
  })

  // D — mixed sources approve (?? coalesces nullish only)
  test("D1: top-level acceptance_criteria + metadata.evidence → no-op", async () => {
    const p = decode({
      session_id: "s",
      hook_event_name: "TaskCompleted",
      task_id: "t1",
      acceptance_criteria: "top-level AC",
      metadata: { evidence: ["from metadata"] },
    })
    const d = await Effect.runPromise(handleTaskCompleted(p))
    expect(d).toEqual({})
  })

  test("D2: metadata.acceptance_criteria + top-level evidence → no-op", async () => {
    const p = decode({
      session_id: "s",
      hook_event_name: "TaskCompleted",
      task_id: "t1",
      metadata: { acceptance_criteria: "from metadata" },
      evidence: ["top-level"],
    })
    const d = await Effect.runPromise(handleTaskCompleted(p))
    expect(d).toEqual({})
  })

  // E — invalid metadata still blocks
  test("E1: metadata.acceptance_criteria whitespace → block", async () => {
    const p = decode({
      session_id: "s",
      hook_event_name: "TaskCompleted",
      task_id: "t1",
      metadata: {
        acceptance_criteria: "   ",
        evidence: ["bun test exit 0"],
      },
    })
    const d = await Effect.runPromise(handleTaskCompleted(p))
    expect("decision" in d).toBe(true)
    if ("decision" in d) {
      expect(d.decision).toBe("block")
      expect(d.reason).toContain("acceptance_criteria")
    }
  })

  test("E2: metadata.evidence empty array → block", async () => {
    const p = decode({
      session_id: "s",
      hook_event_name: "TaskCompleted",
      task_id: "t1",
      metadata: {
        acceptance_criteria: "done",
        evidence: [],
      },
    })
    const d = await Effect.runPromise(handleTaskCompleted(p))
    expect("decision" in d).toBe(true)
    if ("decision" in d) {
      expect(d.decision).toBe("block")
      expect(d.reason).toContain("evidence")
    }
  })

  test("E3: metadata.acceptance_criteria missing (only evidence under metadata) → block", async () => {
    const p = decode({
      session_id: "s",
      hook_event_name: "TaskCompleted",
      task_id: "t1",
      metadata: { evidence: ["x"] },
    })
    const d = await Effect.runPromise(handleTaskCompleted(p))
    expect("decision" in d).toBe(true)
    if ("decision" in d) {
      expect(d.decision).toBe("block")
      expect(d.reason).toContain("acceptance_criteria")
    }
  })

  test("E4: metadata.evidence missing (only AC under metadata) → block", async () => {
    const p = decode({
      session_id: "s",
      hook_event_name: "TaskCompleted",
      task_id: "t1",
      metadata: { acceptance_criteria: "done" },
    })
    const d = await Effect.runPromise(handleTaskCompleted(p))
    expect("decision" in d).toBe(true)
    if ("decision" in d) {
      expect(d.decision).toBe("block")
      expect(d.reason).toContain("evidence")
    }
  })

  test("E5: empty top-level AC string DOES NOT fall through to metadata (?? coalesces nullish only)", async () => {
    // ?? only coalesces null/undefined. An empty string at top-level means
    // metadata is NOT consulted, so missingAc=true → block.
    const p = decode({
      session_id: "s",
      hook_event_name: "TaskCompleted",
      task_id: "t1",
      acceptance_criteria: "",
      evidence: [],
      metadata: {
        acceptance_criteria: "would-have-saved-us",
        evidence: ["x"],
      },
    })
    const d = await Effect.runPromise(handleTaskCompleted(p))
    expect("decision" in d).toBe(true)
    if ("decision" in d) expect(d.decision).toBe("block")
  })
})
