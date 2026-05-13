/**
 * Regression — every SessionState fail-open in the engagement choreography
 * must emit a typed HookFailure diagnostic so silent state failures are observable
 * without contaminating hook stdout.
 *
 * The test drives ONE handler (PreToolUse) with a SessionState layer whose
 * `get` always fails. That exercises the catchAll path and lets us assert
 * the full log line shape without needing to mock five different handler
 * surfaces. The other four catch sites use the same pattern; this single
 * regression test pins the contract.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Schema } from "effect"
import { handlePreToolUse } from "../../src/events/pretool-policy.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { FsError } from "../../src/schema/errors.ts"
import {
  SessionState,
  type SessionStateApi,
} from "../../src/services/session-state.ts"
import { HookFailureTest } from "../../src/services/hook-failure.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

/**
 * Make a SessionState layer whose every method fails with FsError.
 * Used to drive the catchAll path in handlers.
 */
const FailingSessionState: Layer.Layer<SessionState> = Layer.succeed(
  SessionState,
  SessionState.of({
    get: ((..._args: ReadonlyArray<unknown>) =>
      Effect.fail(
        new FsError({
          op: "session-state.get",
          path: "<fail-test>",
          message: "synthetic failure for fail-open logging regression test",
        }),
      )) as SessionStateApi["get"],
    update: ((..._args: ReadonlyArray<unknown>) =>
      Effect.fail(
        new FsError({
          op: "session-state.update",
          path: "<fail-test>",
          message: "synthetic failure",
        }),
      )) as SessionStateApi["update"],
    append: ((..._args: ReadonlyArray<unknown>) =>
      Effect.fail(
        new FsError({
          op: "session-state.append",
          path: "<fail-test>",
          message: "synthetic failure",
        }),
      )) as SessionStateApi["append"],
    appendBatch: ((..._args: ReadonlyArray<unknown>) =>
      Effect.fail(
        new FsError({
          op: "session-state.appendBatch",
          path: "<fail-test>",
          message: "synthetic failure",
        }),
      )) as SessionStateApi["appendBatch"],
    reset: (_sessionId: string) =>
      Effect.fail(
        new FsError({
          op: "session-state.reset",
          path: "<fail-test>",
          message: "synthetic failure",
        }),
      ),
  }),
)

describe("Engagement choreography logs SessionState fail-open paths", () => {
  let origWrite: typeof process.stderr.write
  let captured: string
  beforeEach(() => {
    origWrite = process.stderr.write.bind(process.stderr)
    captured = ""
    ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (
      s: string,
    ) => {
      captured += s
      return true
    }
  })
  afterEach(() => {
    ;(process.stderr as unknown as { write: typeof origWrite }).write = origWrite
  })

  test("PreToolUse emits typed state_read_failed HookFailure", async () => {
    const sid = "fail-log-1"
    const payload = decode({
      _tag: "PreToolUse",
      session_id: sid,
      hook_event_name: "PreToolUse",
      cwd: "/tmp",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/x.ts" },
    })
    const failures = HookFailureTest()
    await Effect.runPromise(
      handlePreToolUse(payload).pipe(
        Effect.provide(FailingSessionState),
        Effect.provide(failures.layer),
      ),
    )
    const records = failures.records()
    expect(records).toHaveLength(1)
    const record = records[0]
    if (record === undefined) throw new Error("missing hook failure record")
    expect(record.kind).toBe("state_read_failed")
    expect(record.event).toBe("PreToolUse")
    expect(record.sessionId).toBe(sid)
    expect(record.hookSafe).toBe(true)
    expect(record.context["op"]).toBe("session-state.get")
    expect(record.context["tool_name"]).toBe("Read")
    expect(record.context["cwd"]).toBe("/tmp")
    expect(record.cause).toContain("synthetic failure")
    expect(captured).toBe("")
  })

  test("cause summaries remain bounded", async () => {
    const failures = HookFailureTest()
    await Effect.runPromise(
      handlePreToolUse(
        decode({
          _tag: "PreToolUse",
          session_id: "bounded",
          hook_event_name: "PreToolUse",
          cwd: "/tmp",
          tool_name: "Read",
          tool_input: { file_path: "/tmp/x.ts" },
        }),
      ).pipe(Effect.provide(FailingSessionState), Effect.provide(failures.layer)),
    )
    const record = failures.records()[0]
    if (record === undefined) throw new Error("missing hook failure record")
    expect(record.cause.length).toBeLessThanOrEqual(300)
  })
})

// Silence unused-import warning — Context is referenced via the Layer
// constructed above through SessionState.of.
void Context
