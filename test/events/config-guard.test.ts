import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { handleConfigChange } from "../../src/events/config-guard.ts"
import { HookPayload } from "../../src/schema/payloads.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

describe("handleConfigChange", () => {
  test("emits additionalContext with scope", async () => {
    const payload = decode({
      _tag: "ConfigChange",
      session_id: "s",
      hook_event_name: "ConfigChange",
      scope: "user",
    })
    const d = await Effect.runPromise(handleConfigChange(payload))
    const out = d as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string }
    }
    expect(out.hookSpecificOutput.hookEventName).toBe("ConfigChange")
    expect(out.hookSpecificOutput.additionalContext).toContain("user")
  })

  test("non-ConfigChange payload → NO_DECISION", async () => {
    const payload = decode({
      _tag: "Stop",
      session_id: "s",
      hook_event_name: "Stop",
    })
    const d = await Effect.runPromise(handleConfigChange(payload))
    expect(d).toEqual({})
  })
})
