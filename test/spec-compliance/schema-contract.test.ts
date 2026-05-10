// Schema-contract tests — assert each Mintlify-documented raw payload
// decodes through HookPayload without errors. Catches wire-payload
// drift before handler-behavior tests muddy the result.
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { HookPayload } from "../../src/schema/payloads.ts"
import * as p from "./fixtures/mintlify-payloads.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

describe("Mintlify documented payloads — schema decode", () => {
  test("PreToolUse decodes", () => expect(decode(p.preToolUse())._tag).toBe("PreToolUse"))
  test("PostToolUse decodes", () => expect(decode(p.postToolUse())._tag).toBe("PostToolUse"))
  test("PostToolUseFailure decodes", () => expect(decode(p.postToolUseFailure())._tag).toBe("PostToolUseFailure"))
  test("PermissionRequest decodes", () => expect(decode(p.permissionRequest())._tag).toBe("PermissionRequest"))
  test("PermissionDenied decodes", () => expect(decode(p.permissionDenied())._tag).toBe("PermissionDenied"))
  test("Stop decodes", () => expect(decode(p.stop())._tag).toBe("Stop"))
  test("StopFailure decodes", () => expect(decode(p.stopFailure())._tag).toBe("StopFailure"))
  test("SubagentStart decodes", () => expect(decode(p.subagentStart())._tag).toBe("SubagentStart"))
  test("SubagentStop decodes", () => expect(decode(p.subagentStop())._tag).toBe("SubagentStop"))
  test("SessionStart decodes", () => expect(decode(p.sessionStart())._tag).toBe("SessionStart"))
  test("SessionEnd decodes", () => expect(decode(p.sessionEnd())._tag).toBe("SessionEnd"))
  test("Setup decodes", () => expect(decode(p.setup())._tag).toBe("Setup"))
  test("PreCompact decodes", () => expect(decode(p.preCompact())._tag).toBe("PreCompact"))
  test("PostCompact decodes", () => expect(decode(p.postCompact())._tag).toBe("PostCompact"))
  test("UserPromptSubmit decodes", () => expect(decode(p.userPromptSubmit())._tag).toBe("UserPromptSubmit"))
  test("Notification decodes", () => expect(decode(p.notification())._tag).toBe("Notification"))
  test("Elicitation decodes", () => expect(decode(p.elicitation())._tag).toBe("Elicitation"))
  test("ElicitationResult decodes", () => expect(decode(p.elicitationResult())._tag).toBe("ElicitationResult"))
  test("ConfigChange decodes", () => expect(decode(p.configChange())._tag).toBe("ConfigChange"))
  test("InstructionsLoaded decodes", () => expect(decode(p.instructionsLoaded())._tag).toBe("InstructionsLoaded"))
  test("WorktreeCreate decodes", () => expect(decode(p.worktreeCreate())._tag).toBe("WorktreeCreate"))
  test("WorktreeRemove decodes", () => expect(decode(p.worktreeRemove())._tag).toBe("WorktreeRemove"))
  test("CwdChanged decodes", () => expect(decode(p.cwdChanged())._tag).toBe("CwdChanged"))
  test("FileChanged decodes", () => expect(decode(p.fileChanged())._tag).toBe("FileChanged"))
  test("TaskCreated (guide-only) decodes", () => expect(decode(p.taskCreated())._tag).toBe("TaskCreated"))
  test("TaskCompleted documented-only payload decodes", () => expect(decode(p.taskCompletedDocumentedOnly())._tag).toBe("TaskCompleted"))
  test("TaskCompleted with metadata.AC+evidence decodes (post-patch schema)", () => {
    const decoded = decode(p.taskCompletedWithMetadata())
    expect(decoded._tag).toBe("TaskCompleted")
    expect((decoded as { metadata?: unknown }).metadata).toBeDefined()
  })
})
