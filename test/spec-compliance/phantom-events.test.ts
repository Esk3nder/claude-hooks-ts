// Phantom events — _tags shipped by claude-hooks-ts but absent from
// mintlify.wiki/.../hooks-reference.md (verdict PHANTOM in audit grid).
//
// As of 2026-05-10:
//   - PostToolBatch       (batch-context-governor.ts)
//   - UserPromptExpansion (user-prompt-expansion.ts)
//   - TeammateIdle        (teammate-idle.ts)
//
// These tests assert the schemas accept a minimal raw payload and
// handlers run cleanly under the spec-compliance Layer. If Mintlify
// later documents one of these events, move it to handler-smoke.test.ts.
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { HookPayload } from "../../src/schema/payloads.ts"
import { handlePostToolBatch } from "../../src/events/batch-context-governor.ts"
import { handleUserPromptExpansion } from "../../src/events/user-prompt-expansion.ts"
import { handleTeammateIdle } from "../../src/events/teammate-idle.ts"
import { runHook, SPEC_ROOT } from "./helpers.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const sessionEnvelope = {
  session_id: "spec-session",
  transcript_path: `${SPEC_ROOT}/transcript.jsonl`,
  cwd: SPEC_ROOT,
}

const isWellFormedDecision = (d: unknown): boolean =>
  d === null || typeof d === "object" || typeof d === "string"

describe("PHANTOM events — undocumented in Mintlify, audited for stability", () => {
  test("PostToolBatch: schema decodes a minimal raw payload", () => {
    const decoded = decode({
      hook_event_name: "PostToolBatch",
      tools: [],
      ...sessionEnvelope,
    })
    expect(decoded._tag).toBe("PostToolBatch")
  })

  test("PostToolBatch: handler runs under test layer without throwing", async () => {
    const decoded = decode({
      hook_event_name: "PostToolBatch",
      tools: [],
      ...sessionEnvelope,
    })
    const d = await runHook("s", handlePostToolBatch(decoded as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })

  test("UserPromptExpansion: schema decodes a minimal raw payload", () => {
    const decoded = decode({
      hook_event_name: "UserPromptExpansion",
      prompt: "x",
      ...sessionEnvelope,
    })
    expect(decoded._tag).toBe("UserPromptExpansion")
  })

  test("UserPromptExpansion: handler runs under test layer without throwing", async () => {
    const decoded = decode({
      hook_event_name: "UserPromptExpansion",
      prompt: "x",
      ...sessionEnvelope,
    })
    const d = await runHook("s", handleUserPromptExpansion(decoded as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })

  test("TeammateIdle: schema decodes a minimal raw payload", () => {
    const decoded = decode({
      hook_event_name: "TeammateIdle",
      teammate_name: "claude",
      teammate_type: "general-purpose",
      ...sessionEnvelope,
    })
    expect(decoded._tag).toBe("TeammateIdle")
  })

  test("TeammateIdle: handler runs under test layer without throwing", async () => {
    const decoded = decode({
      hook_event_name: "TeammateIdle",
      teammate_name: "claude",
      teammate_type: "general-purpose",
      ...sessionEnvelope,
    })
    const d = await runHook("s", handleTeammateIdle(decoded as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
})
