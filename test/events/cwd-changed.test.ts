import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { handleCwdChanged } from "../../src/events/cwd-changed.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { FileSystemTest } from "../../src/services/filesystem.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

describe("handleCwdChanged", () => {
  test("injects context when new_cwd has .claude-hooks/", async () => {
    const layer = Layer.mergeAll(
      FileSystemTest(new Map([["/new/.claude-hooks", ""]])),
    )
    const payload = decode({
      _tag: "CwdChanged",
      session_id: "s1",
      hook_event_name: "CwdChanged",
      previous_cwd: "/old",
      new_cwd: "/new",
    })
    const d = await Effect.runPromise(
      handleCwdChanged(payload).pipe(Effect.provide(layer)),
    )
    expect((d as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext).toContain(
      "/new/.claude-hooks/",
    )
  })

  test("SAFE_DEFAULT when no project-local config", async () => {
    const layer = FileSystemTest()
    const payload = decode({
      _tag: "CwdChanged",
      session_id: "s1",
      hook_event_name: "CwdChanged",
      previous_cwd: "/a",
      new_cwd: "/b",
    })
    const d = await Effect.runPromise(
      handleCwdChanged(payload).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
  })
})
