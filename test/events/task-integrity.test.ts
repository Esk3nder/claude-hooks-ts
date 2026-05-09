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
  handleTaskCompleted,
} from "../../src/events/task-integrity.ts"
import { HookPayload } from "../../src/schema/payloads.ts"

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
