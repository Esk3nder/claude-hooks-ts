import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  handleSubagentStart,
  handleSubagentStop,
} from "../../src/events/subagent-scope-gate.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { SessionStateTest } from "../../src/services/session-state.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const startPayload = (agent_type: string) =>
  decode({
    _tag: "SubagentStart",
    session_id: "s",
    hook_event_name: "SubagentStart",
    agent_type,
    agent_id: "a1",
    prompt: "do the thing",
  })

const stopPayload = (agent_type: string, output: string | undefined) =>
  decode({
    _tag: "SubagentStop",
    session_id: "s",
    hook_event_name: "SubagentStop",
    agent_type,
    agent_id: "a1",
    ...(output === undefined ? {} : { output }),
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
      expect(out.additionalContext).toContain("Output contract")
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

  test("missing output → block for investigative role", async () => {
    const d = await Effect.runPromise(
      handleSubagentStop(stopPayload("Explore", undefined)).pipe(
        Effect.provide(SessionStateTest()),
      ),
    )
    if ("decision" in d) {
      expect(d.decision).toBe("block")
    }
  })

  test("legacy subagent_type / result fields still work (backward compat)", async () => {
    const d = await Effect.runPromise(
      handleSubagentStop(
        decode({
          _tag: "SubagentStop",
          session_id: "s-legacy",
          hook_event_name: "SubagentStop",
          subagent_type: "Explore",
          task_id: "t-legacy",
          result: "found bug at src/foo.ts:42 — confidence: high",
        }),
      ).pipe(Effect.provide(SessionStateTest())),
    )
    expect(d).toEqual({})
  })

  test("investigative subagent stop still blocks after a prior missing-evidence block", async () => {
    const payload = stopPayload("Explore", "ok done")
    const program = Effect.gen(function* () {
      const first = yield* handleSubagentStop(payload)
      const second = yield* handleSubagentStop(payload)
      return { first, second }
    }).pipe(Effect.provide(SessionStateTest()))

    const r = await Effect.runPromise(program)
    expect("decision" in r.first).toBe(true)
    expect("decision" in r.second).toBe(true)
    if ("decision" in r.second) {
      expect(r.second.decision).toBe("block")
      expect(r.second.reason).toContain("Output contract")
    }
  })
})

describe("M11 invocation key — agent_id is canonical", () => {
  test("agent_id is used verbatim as the identity", async () => {
    const p = decode({
      _tag: "SubagentStart",
      session_id: "s1",
      hook_event_name: "SubagentStart",
      agent_type: "Explore",
      agent_id: "agent-42",
      cwd: "/repo",
    })
    const { invocationKey } = await import(
      "../../src/events/subagent-scope-gate.ts"
    )
    const k = invocationKey(
      p as unknown as Record<string, unknown> & {
        _tag: string
        session_id: string
      },
    )
    expect(k).toBe("s1:Explore:agent-42")
  })

  test("legacy task_id is honoured when agent_id is absent", async () => {
    const p = decode({
      _tag: "SubagentStart",
      session_id: "s1",
      hook_event_name: "SubagentStart",
      subagent_type: "Explore",
      task_id: "task-42",
      cwd: "/repo",
    })
    const { invocationKey } = await import(
      "../../src/events/subagent-scope-gate.ts"
    )
    const k = invocationKey(
      p as unknown as Record<string, unknown> & {
        _tag: string
        session_id: string
      },
    )
    expect(k).toBe("s1:Explore:task-42")
  })

  test("two parallel SubagentStarts without agent_id/task_id produce distinct keys", async () => {
    const p1 = decode({
      _tag: "SubagentStart",
      session_id: "s1",
      hook_event_name: "SubagentStart",
      agent_type: "Explore",
      cwd: "/repo/a",
    })
    const p2 = decode({
      _tag: "SubagentStart",
      session_id: "s1",
      hook_event_name: "SubagentStart",
      agent_type: "Explore",
      cwd: "/repo/b",
    })
    const { invocationKey } = await import(
      "../../src/events/subagent-scope-gate.ts"
    )
    const k1 = invocationKey(
      p1 as unknown as Record<string, unknown> & {
        _tag: string
        session_id: string
      },
    )
    const k2 = invocationKey(
      p2 as unknown as Record<string, unknown> & {
        _tag: string
        session_id: string
      },
    )
    expect(k1).not.toBe(k2)
    expect(k1.startsWith("s1:Explore:")).toBe(true)
    expect(k2.startsWith("s1:Explore:")).toBe(true)
  })

  test("identical payloads collapse to the same key (idempotent)", async () => {
    const make = () =>
      decode({
        _tag: "SubagentStart",
        session_id: "s1",
        hook_event_name: "SubagentStart",
        agent_type: "Explore",
        cwd: "/repo",
      })
    const { invocationKey } = await import(
      "../../src/events/subagent-scope-gate.ts"
    )
    const a = invocationKey(
      make() as unknown as Record<string, unknown> & {
        _tag: string
        session_id: string
      },
    )
    const b = invocationKey(
      make() as unknown as Record<string, unknown> & {
        _tag: string
        session_id: string
      },
    )
    expect(a).toBe(b)
  })
})
