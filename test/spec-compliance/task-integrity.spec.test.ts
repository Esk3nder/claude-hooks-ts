// Spec-compliance perspective on task-integrity.
//
// Verdict: POLICY_EXTENSION.
//
// Strict Mintlify payload (per guides/hooks.md) for TaskCompleted is
// `{ task_id, task_subject, task_description, teammate_name, team_name }`.
// Neither `acceptance_criteria` nor `evidence` is in the documented
// contract. The package intentionally enforces a completion-discipline
// gate that requires both.
//
// Post-patch the gate also accepts the fields under `metadata`, which is
// the only writable freeform parameter on the current Claude Code
// TaskUpdate tool surface. This file pins both halves: the documented
// payload alone still blocks, and the metadata bridge approves.
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { HookPayload } from "../../src/schema/payloads.ts"
import { handleTaskCompleted as handleTaskCompletedRaw } from "../../src/events/task-integrity.ts"
import { SessionStateTest } from "../../src/services/session-state.ts"
import {
  taskCompletedDocumentedOnly,
  taskCompletedWithMetadata,
} from "./fixtures/mintlify-payloads.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const handleTaskCompleted = (
  payload: Parameters<typeof handleTaskCompletedRaw>[0],
) => handleTaskCompletedRaw(payload).pipe(Effect.provide(SessionStateTest()))

describe("task-integrity — Mintlify spec-compliance audit (POLICY_EXTENSION)", () => {
  test("documented-only payload BLOCKS (intentional package policy)", async () => {
    const d = await Effect.runPromise(
      handleTaskCompleted(decode(taskCompletedDocumentedOnly()) as never),
    )
    expect("decision" in d).toBe(true)
    if ("decision" in d) {
      expect(d.decision).toBe("block")
      expect(d.reason).toContain("acceptance_criteria")
    }
  })

  test("metadata.AC + metadata.evidence (post-patch) APPROVES", async () => {
    const d = await Effect.runPromise(
      handleTaskCompleted(decode(taskCompletedWithMetadata()) as never),
    )
    expect(d).toEqual({})
  })
})
