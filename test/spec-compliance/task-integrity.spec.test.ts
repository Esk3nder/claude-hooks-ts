// Spec-compliance perspective on task-integrity.
//
// Verdict: POLICY_EXTENSION (opt-in via active ISA).
//
// Strict Mintlify payload (per guides/hooks.md) for TaskCompleted is
// `{ task_id, task_subject, task_description, teammate_name, team_name }`.
// Neither `acceptance_criteria` nor `evidence` is in the documented
// contract. Claude Code's TaskUpdate tool also drops user-provided
// `metadata`, so the package CANNOT receive AC/evidence through the
// standard surface.
//
// Resolution: the AC/evidence native-field requirement is opt-in via
// active-ISA presence — the same convention as the ISA-evidence check.
// Without an ISA, the documented-only payload is a lightweight
// bookkeeping signal and passes. With an ISA, the strict gate fires.
// `metadata.*` is still accepted for non-Claude-Code dispatchers.
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
  test("documented-only payload WITHOUT active ISA APPROVES (lightweight bookkeeping)", async () => {
    const d = await Effect.runPromise(
      handleTaskCompleted(decode(taskCompletedDocumentedOnly()) as never),
    )
    expect(d).toEqual({})
  })

  test("metadata.AC + metadata.evidence APPROVES (non-Claude-Code dispatcher path)", async () => {
    const d = await Effect.runPromise(
      handleTaskCompleted(decode(taskCompletedWithMetadata()) as never),
    )
    expect(d).toEqual({})
  })
})
