import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  NormalizedHookEvent,
  type NormalizedSubagentStart,
  type NormalizedSubagentStop,
} from "../src/schema/normalized.ts"
import { WorkerLaunchInput } from "../src/schema/worker.ts"

const decodeEvent = (raw: unknown) =>
  Schema.decodeUnknownSync(NormalizedHookEvent)(raw)

const decodeStart = (raw: unknown): NormalizedSubagentStart =>
  decodeEvent(raw) as NormalizedSubagentStart

const decodeStop = (raw: unknown): NormalizedSubagentStop =>
  decodeEvent(raw) as NormalizedSubagentStop

describe("NormalizedHookEvent schema", () => {
  test("normalizes legacy subagent_type/task_id/result into canonical fields", () => {
    const event = decodeStop({
      session_id: "s1",
      hook_event_name: "SubagentStop",
      subagent_type: "Explore",
      task_id: "task-1",
      result: "found src/foo.ts:1; confidence: high",
    })

    expect(event.agent_type).toBe("Explore")
    expect(event.agent_id).toBe("task-1")
    expect(event.output).toBe("found src/foo.ts:1; confidence: high")

    const record = event as unknown as Record<string, unknown>
    expect(record["subagent_type"]).toBeUndefined()
    expect(record["task_id"]).toBeUndefined()
    expect(record["result"]).toBeUndefined()
  })

  test("canonical subagent fields win over legacy aliases", () => {
    const event = decodeStop({
      session_id: "s1",
      hook_event_name: "SubagentStop",
      agent_type: "planner",
      subagent_type: "Explore",
      agent_id: "agent-1",
      task_id: "task-1",
      output: "Recommendation: keep it. Confidence: high",
      result: "legacy result",
    })

    expect(event.agent_type).toBe("planner")
    expect(event.agent_id).toBe("agent-1")
    expect(event.output).toBe("Recommendation: keep it. Confidence: high")
  })

  test("missing subagent identity gets a deterministic stable hash in one normalizer", () => {
    const a = decodeStart({
      session_id: "s1",
      hook_event_name: "SubagentStart",
      agent_type: "Explore",
      prompt: "inspect a",
    })
    const b = decodeStart({
      session_id: "s1",
      hook_event_name: "SubagentStart",
      agent_type: "Explore",
      prompt: "inspect a",
    })
    const c = decodeStart({
      session_id: "s1",
      hook_event_name: "SubagentStart",
      agent_type: "Explore",
      prompt: "inspect b",
    })

    expect(a.agent_id).toMatch(/^h[0-9a-f]{16}$/)
    expect(a.agent_id).toBe(b.agent_id)
    expect(a.agent_id).not.toBe(c.agent_id)
  })

  test("worker launch input normalizes agent_type aliases before policy code", () => {
    const input = Schema.decodeUnknownSync(WorkerLaunchInput)({
      description: "inspect",
      prompt: "find evidence",
      subagent_type: "Explore",
    })

    expect(input).toEqual({
      description: "inspect",
      prompt: "find evidence",
      agent_type: "Explore",
    })
  })
})
