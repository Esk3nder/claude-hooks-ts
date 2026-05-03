import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { handlePermissionRequest } from "../../src/events/permission-autopilot.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { ApprovalsTest } from "../../src/services/approvals.ts"
import { ProjectTest } from "../../src/services/project.ts"
import { derivePatternKey } from "../../src/policies/permission-patterns.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const requestPayload = (toolName: string, toolInput: unknown, cwd = "/repo") =>
  decode({
    _tag: "PermissionRequest",
    session_id: "s",
    cwd,
    hook_event_name: "PermissionRequest",
    tool_name: toolName,
    tool_input: toolInput,
  })

describe("VAL-M4-002 permission-autopilot", () => {
  test("approved pattern → allow", async () => {
    const pattern = derivePatternKey("Bash", { command: "git status" })
    const layer = Layer.mergeAll(
      ProjectTest({ root: "/repo" }),
      ApprovalsTest([
        { cwd: "/repo", pattern, status: "approved", recordedAt: 1 },
      ]),
    )
    const d = await Effect.runPromise(
      handlePermissionRequest(
        requestPayload("Bash", { command: "git status" }),
      ).pipe(Effect.provide(layer)),
    )
    expect("hookSpecificOutput" in d).toBe(true)
    if ("hookSpecificOutput" in d) {
      const out = d.hookSpecificOutput as {
        permissionDecision: string
        permissionDecisionReason: string
        hookEventName: string
      }
      expect(out.permissionDecision).toBe("allow")
      expect(out.hookEventName).toBe("PermissionRequest")
      expect(out.permissionDecisionReason).toContain("auto-approved")
    }
  })

  test("denied pattern → deny", async () => {
    const pattern = derivePatternKey("Bash", { command: "rm -rf" })
    const layer = Layer.mergeAll(
      ProjectTest({ root: "/repo" }),
      ApprovalsTest([
        { cwd: "/repo", pattern, status: "denied", recordedAt: 1 },
      ]),
    )
    const d = await Effect.runPromise(
      handlePermissionRequest(
        requestPayload("Bash", { command: "rm -rf /tmp/x" }),
      ).pipe(Effect.provide(layer)),
    )
    if ("hookSpecificOutput" in d) {
      const out = d.hookSpecificOutput as { permissionDecision: string }
      expect(out.permissionDecision).toBe("deny")
    }
  })

  test("unseen pattern → ask", async () => {
    const layer = Layer.mergeAll(ProjectTest({ root: "/repo" }), ApprovalsTest())
    const d = await Effect.runPromise(
      handlePermissionRequest(
        requestPayload("Bash", { command: "echo hi" }),
      ).pipe(Effect.provide(layer)),
    )
    if ("hookSpecificOutput" in d) {
      const out = d.hookSpecificOutput as { permissionDecision: string }
      expect(out.permissionDecision).toBe("ask")
    }
  })
})
