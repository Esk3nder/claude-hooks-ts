/**
 * PostToolUse engaged-marker: writing an ISA file should clear
 * `engagement_required` and stamp `isa_engaged_at` on SessionState.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { handlePostToolUse } from "../../src/events/post-edit-quality.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { ProjectTest } from "../../src/services/project.ts"
import { ShellTest } from "../../src/services/shell.ts"
import { RedactTest } from "../../src/services/redact.ts"
import {
  SessionState,
  SessionStateTest,
  EMPTY_SESSION_STATE,
} from "../../src/services/session-state.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const editPayload = (file: string, sid = "engaged-1") =>
  decode({
    _tag: "PostToolUse",
    session_id: sid,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: file },
    tool_response: { success: true },
  })

const baseLayer = Layer.mergeAll(ProjectTest(), RedactTest(), ShellTest())

describe("PostToolUse engaged-marker", () => {
  test("Edit on ISA.md → stamps isa_engaged_at; engagement_required PRESERVED", async () => {
    const sid = "engaged-1"
    const seed = new Map([
      [
        sid,
        {
          ...EMPTY_SESSION_STATE,
          engagement_required: true,
          last_mode: "ALGORITHM",
          last_tier: 3,
          expected_isa_path: ".claude-hooks/state/work/engaged-1/ISA.md",
        },
      ],
    ])
    const stateLayer = SessionStateTest(seed)
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handlePostToolUse(
          editPayload("/repo/.claude-hooks/state/work/engaged-1/ISA.md", sid),
        )
        const s = yield* SessionState
        return yield* s.get(sid)
      }).pipe(Effect.provide(Layer.mergeAll(baseLayer, stateLayer))),
    )
    // Historical truth preserved: this session WAS supposed to engage ISA.
    expect(record.engagement_required).toBe(true)
    expect(record.isa_engaged_at).not.toBeNull()
    expect(record.isa_engaged_at ?? "").toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test("Edit on non-ISA file → no engaged-marker stamp; flag preserved", async () => {
    const sid = "engaged-2"
    const seed = new Map([
      [
        sid,
        {
          ...EMPTY_SESSION_STATE,
          engagement_required: true,
          last_mode: "ALGORITHM",
          last_tier: 3,
        },
      ],
    ])
    const stateLayer = SessionStateTest(seed)
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handlePostToolUse(editPayload("/repo/src/foo.ts", sid))
        const s = yield* SessionState
        return yield* s.get(sid)
      }).pipe(Effect.provide(Layer.mergeAll(baseLayer, stateLayer))),
    )
    expect(record.engagement_required).toBe(true)
    expect(record.isa_engaged_at).toBeNull()
  })

  test("Edit on project ISA at <repo>/ISA.md → also stamps isa_engaged_at", async () => {
    const sid = "engaged-3"
    const seed = new Map([
      [sid, { ...EMPTY_SESSION_STATE, engagement_required: true }],
    ])
    const stateLayer = SessionStateTest(seed)
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handlePostToolUse(editPayload("/repo/ISA.md", sid))
        const s = yield* SessionState
        return yield* s.get(sid)
      }).pipe(Effect.provide(Layer.mergeAll(baseLayer, stateLayer))),
    )
    expect(record.engagement_required).toBe(true)
    expect(record.isa_engaged_at).not.toBeNull()
  })
})
