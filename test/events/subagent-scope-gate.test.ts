import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  handleSubagentStart,
  handleSubagentStop,
} from "../../src/events/subagent-scope-gate.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { SessionStateTest } from "../../src/services/session-state.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const startPayload = (subagent_type: string) =>
  decode({
    _tag: "SubagentStart",
    session_id: "s",
    hook_event_name: "SubagentStart",
    subagent_type,
    task_id: "t1",
  })

const stopPayload = (subagent_type: string, result: string | undefined) =>
  decode({
    _tag: "SubagentStop",
    session_id: "s",
    hook_event_name: "SubagentStop",
    subagent_type,
    task_id: "t1",
    ...(result === undefined ? {} : { result }),
  })

describe("VAL-M4-003 subagent-scope-gate", () => {
  test("Explore start injects read-only scope rule", async () => {
    const d = await Effect.runPromise(
      handleSubagentStart(startPayload("Explore")).pipe(
        Effect.provide(SessionStateTest()),
      ),
    )
    expect("hookSpecificOutput" in d).toBe(true)
    if ("hookSpecificOutput" in d) {
      const out = d.hookSpecificOutput as { additionalContext: string }
      expect(out.additionalContext).toContain("read-only investigator")
      expect(out.additionalContext).toContain("Explore")
    }
  })

  test("general-purpose start injects write-allowed rule", async () => {
    const d = await Effect.runPromise(
      handleSubagentStart(startPayload("general-purpose")).pipe(
        Effect.provide(SessionStateTest()),
      ),
    )
    if ("hookSpecificOutput" in d) {
      const out = d.hookSpecificOutput as { additionalContext: string }
      expect(out.additionalContext).toContain("modify files")
    }
  })

  test("investigative subagent stop without evidence → block", async () => {
    const d = await Effect.runPromise(
      handleSubagentStop(stopPayload("Explore", "ok done")).pipe(
        Effect.provide(SessionStateTest()),
      ),
    )
    expect("decision" in d).toBe(true)
    if ("decision" in d) {
      expect(d.decision).toBe("block")
      expect(d.reason).toContain("evidence")
    }
  })

  test("investigative subagent stop with evidence → no-op", async () => {
    const d = await Effect.runPromise(
      handleSubagentStop(
        stopPayload("Explore", "found bug at src/foo.ts:42 — confidence: high"),
      ).pipe(Effect.provide(SessionStateTest())),
    )
    expect(d).toEqual({})
  })

  test("non-investigative subagent stop never blocks", async () => {
    const d = await Effect.runPromise(
      handleSubagentStop(stopPayload("general-purpose", "done")).pipe(
        Effect.provide(SessionStateTest()),
      ),
    )
    expect(d).toEqual({})
  })

  test("missing result → block for investigative role", async () => {
    const d = await Effect.runPromise(
      handleSubagentStop(stopPayload("Explore", undefined)).pipe(
        Effect.provide(SessionStateTest()),
      ),
    )
    if ("decision" in d) {
      expect(d.decision).toBe("block")
    }
  })
})
