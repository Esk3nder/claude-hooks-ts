import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { handleUserPromptExpansion } from "../../src/events/user-prompt-expansion.ts"
import { HookPayload } from "../../src/schema/payloads.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const exp = (prompt: string, expanded?: string) =>
  decode({
    _tag: "UserPromptExpansion",
    session_id: "s1",
    hook_event_name: "UserPromptExpansion",
    prompt,
    ...(expanded !== undefined ? { expanded_prompt: expanded } : {}),
  })

describe("handleUserPromptExpansion", () => {
  test("deploy command → injects warning", async () => {
    const d = await Effect.runPromise(
      handleUserPromptExpansion(exp("/deploy", "deploy to production")),
    )
    const out = d as {
      hookSpecificOutput?: { additionalContext?: string }
    }
    expect(out.hookSpecificOutput?.additionalContext).toContain(
      "high-blast-radius",
    )
  })

  test("migration command → injects warning", async () => {
    const d = await Effect.runPromise(
      handleUserPromptExpansion(
        exp("/db", "run database migration to backfill schema"),
      ),
    )
    const out = d as {
      hookSpecificOutput?: { additionalContext?: string }
    }
    expect(out.hookSpecificOutput?.additionalContext).toContain(
      "high-blast-radius",
    )
  })

  test("benign expansion → SAFE_DEFAULT", async () => {
    const d = await Effect.runPromise(
      handleUserPromptExpansion(exp("/help", "show me the help text")),
    )
    expect(d).toEqual({})
  })

  test("non-UserPromptExpansion payload → SAFE_DEFAULT", async () => {
    const payload = decode({
      _tag: "Stop",
      session_id: "s",
      hook_event_name: "Stop",
    })
    const d = await Effect.runPromise(handleUserPromptExpansion(payload))
    expect(d).toEqual({})
  })
})
