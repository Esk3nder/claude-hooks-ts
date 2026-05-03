import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  handleTaskCreated,
  handleTaskCompleted,
} from "../../src/events/task-integrity.ts"
import { HookPayload } from "../../src/schema/payloads.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

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
