// Handler smoke audit — drives each shipped handler with its
// Mintlify-documented decoded payload under the spec-compliance Layer.
//
// Verdict legend (annotated alongside each test, not enforced):
//   OK                 — payload decodes; handler returns a well-formed
//                        HookDecision (NO_DECISION, block, or richer
//                        hookSpecificOutput shape).
//   POLICY_EXTENSION   — handler may block by intentional package policy
//                        (e.g. task-integrity AC/evidence gate).
//   DOC_DRIFT          — schema field names diverge from Mintlify;
//                        fixtures use schema names so handlers can run.
//   PHANTOM            — event has no Mintlify documentation; tested in
//                        phantom-events.test.ts instead.
//
// Test contract: each handler must run to completion under the test layer
// without throwing. The return value must be an object/string (any
// HookDecision union member). Throws (e.g. unprovided service, schema
// decode errors) are real failures.
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { HookPayload } from "../../src/schema/payloads.ts"

import { handlePreToolUse } from "../../src/events/pretool-policy.ts"
import { handlePostToolUse } from "../../src/events/post-edit-quality.ts"
import { handlePostToolUseFailure } from "../../src/events/failure-explainer.ts"
import { handlePermissionRequest } from "../../src/events/permission-autopilot.ts"
import { handlePermissionDenied } from "../../src/events/permission-denied.ts"
import { handleStop } from "../../src/events/stop-definition-of-done.ts"
import { handleStopFailure } from "../../src/events/stop-failure.ts"
import {
  handleSubagentStart,
  handleSubagentStop,
} from "../../src/events/subagent-scope-gate.ts"
import { handleSessionStart } from "../../src/events/session-start-brief.ts"
import { handleSessionEnd } from "../../src/events/session-ledger.ts"
import { handleSetup } from "../../src/events/setup.ts"
import { handlePreCompact } from "../../src/events/precompact-snapshot.ts"
import { handlePostCompact } from "../../src/events/postcompact-ledger.ts"
import { handleUserPromptSubmit } from "../../src/events/prompt-router.ts"
import { handleNotification } from "../../src/events/notification.ts"
import { handleElicitation } from "../../src/events/elicitation.ts"
import { handleElicitationResult } from "../../src/events/elicitation-result.ts"
import { handleConfigChange } from "../../src/events/config-guard.ts"
import { handleInstructionsLoaded } from "../../src/events/instructions-loaded.ts"
import { handleWorktreeCreate } from "../../src/events/worktree-create.ts"
import { handleWorktreeRemove } from "../../src/events/worktree-remove.ts"
import { handleCwdChanged } from "../../src/events/cwd-changed.ts"
import { handleFileChanged } from "../../src/events/filechanged-env-guard.ts"
import {
  handleTaskCreated,
  handleTaskCompleted as handleTaskCompletedRaw,
} from "../../src/events/task-integrity.ts"
import { SessionStateTest } from "../../src/services/session-state.ts"

const handleTaskCompleted = (
  payload: Parameters<typeof handleTaskCompletedRaw>[0],
) => handleTaskCompletedRaw(payload).pipe(Effect.provide(SessionStateTest()))

import * as p from "./fixtures/mintlify-payloads.ts"
import { runHook } from "./helpers.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

// HookDecision is a union: NO_DECISION `{}`, block `{decision,reason}`,
// PreToolUseDecision/PermissionRequestDecision/ContextInjection
// `{hookSpecificOutput:...}`, WorktreeCreateDecision (a raw string), etc.
const isWellFormedDecision = (d: unknown): boolean =>
  d === null || typeof d === "object" || typeof d === "string"

describe("Mintlify handler smoke — documented payloads run cleanly", () => {
  test("PreToolUse [OK]", async () => {
    const d = await runHook("s", handlePreToolUse(decode(p.preToolUse()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("PostToolUse [OK]", async () => {
    const d = await runHook("s", handlePostToolUse(decode(p.postToolUse()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("PostToolUseFailure [OK]", async () => {
    const d = await runHook("s", handlePostToolUseFailure(decode(p.postToolUseFailure()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("PermissionRequest [OK]", async () => {
    const d = await runHook("s", handlePermissionRequest(decode(p.permissionRequest()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("PermissionDenied [OK / DOC_DRIFT name]", async () => {
    const d = await runHook("s", handlePermissionDenied(decode(p.permissionDenied()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("Stop [OK]", async () => {
    const d = await runHook("s", handleStop(decode(p.stop()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("StopFailure [OK / DOC_DRIFT names]", async () => {
    const d = await runHook("s", handleStopFailure(decode(p.stopFailure()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("SubagentStart [OK]", async () => {
    const d = await runHook("s", handleSubagentStart(decode(p.subagentStart()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("SubagentStop [OK]", async () => {
    const d = await runHook("s", handleSubagentStop(decode(p.subagentStop()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("SessionStart [OK]", async () => {
    const d = await runHook("s", handleSessionStart(decode(p.sessionStart()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("SessionEnd [OK]", async () => {
    const d = await runHook("s", handleSessionEnd(decode(p.sessionEnd()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("Setup [OK]", async () => {
    const d = await runHook("s", handleSetup(decode(p.setup()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("PreCompact [OK / DOC_DRIFT custom_instructions]", async () => {
    const d = await runHook("s", handlePreCompact(decode(p.preCompact()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("PostCompact [OK]", async () => {
    const d = await runHook("s", handlePostCompact(decode(p.postCompact()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("UserPromptSubmit [OK]", async () => {
    const d = await runHook("s", handleUserPromptSubmit(decode(p.userPromptSubmit()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("Notification [OK]", async () => {
    const d = await runHook("s", handleNotification(decode(p.notification()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("Elicitation [OK / DOC_DRIFT names]", async () => {
    const d = await runHook("s", handleElicitation(decode(p.elicitation()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("ElicitationResult [OK / DOC_DRIFT names]", async () => {
    const d = await runHook("s", handleElicitationResult(decode(p.elicitationResult()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("ConfigChange [OK]", async () => {
    const d = await runHook("s", handleConfigChange(decode(p.configChange()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("InstructionsLoaded [OK]", async () => {
    const d = await runHook("s", handleInstructionsLoaded(decode(p.instructionsLoaded()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("WorktreeCreate [OK / DOC_DRIFT names]", async () => {
    const d = await runHook("s", handleWorktreeCreate(decode(p.worktreeCreate()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("WorktreeRemove [OK]", async () => {
    const d = await runHook("s", handleWorktreeRemove(decode(p.worktreeRemove()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("CwdChanged [OK / DOC_DRIFT name previous_cwd]", async () => {
    const d = await runHook("s", handleCwdChanged(decode(p.cwdChanged()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("FileChanged [OK]", async () => {
    const d = await runHook("s", handleFileChanged(decode(p.fileChanged()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("TaskCreated [OK, guide-only]", async () => {
    const d = await Effect.runPromise(handleTaskCreated(decode(p.taskCreated()) as never))
    expect(isWellFormedDecision(d)).toBe(true)
  })
  test("TaskCompleted [POLICY_EXTENSION] — documented-only payload (no AC/evidence/ISA) APPROVES as lightweight bookkeeping", async () => {
    // Claude Code's TaskUpdate drops user-provided metadata, so the
    // documented-only shape carries no AC/evidence signal. The native
    // gate is opt-in via either AC/evidence intent or active ISA;
    // without both, this is bookkeeping and passes.
    const d = await Effect.runPromise(
      handleTaskCompleted(decode(p.taskCompletedDocumentedOnly()) as never),
    )
    expect(d).toEqual({})
  })
  test("TaskCompleted [POLICY_EXTENSION post-patch] — metadata.AC+evidence APPROVES", async () => {
    const d = await Effect.runPromise(
      handleTaskCompleted(decode(p.taskCompletedWithMetadata()) as never),
    )
    expect(d).toEqual({})
  })
})
