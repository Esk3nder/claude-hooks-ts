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

describe("VAL-M4-002 permission-autopilot (M11 spec-conformant output)", () => {
  test("approved pattern → decision.behavior=allow", async () => {
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
        hookEventName: string
        decision: { behavior: string; message?: string }
      }
      expect(out.hookEventName).toBe("PermissionRequest")
      expect(out.decision.behavior).toBe("allow")
    }
  })

  test("denied pattern → decision.behavior=deny with message", async () => {
    const command = "rm -rf /tmp/x"
    const pattern = derivePatternKey("Bash", { command })
    const layer = Layer.mergeAll(
      ProjectTest({ root: "/repo" }),
      ApprovalsTest([
        { cwd: "/repo", pattern, status: "denied", recordedAt: 1 },
      ]),
    )
    const d = await Effect.runPromise(
      handlePermissionRequest(
        requestPayload("Bash", { command }),
      ).pipe(Effect.provide(layer)),
    )
    expect("hookSpecificOutput" in d).toBe(true)
    if ("hookSpecificOutput" in d) {
      const out = d.hookSpecificOutput as {
        decision: { behavior: string; message?: string }
      }
      expect(out.decision.behavior).toBe("deny")
      expect(out.decision.message ?? "").toContain("auto-denied")
    }
  })

  test("approved exact command does not auto-allow command with same prefix", async () => {
    const pattern = derivePatternKey("Bash", { command: "npm test" })
    const layer = Layer.mergeAll(
      ProjectTest({ root: "/repo" }),
      ApprovalsTest([
        { cwd: "/repo", pattern, status: "approved", recordedAt: 1 },
      ]),
    )
    const d = await Effect.runPromise(
      handlePermissionRequest(
        requestPayload("Bash", { command: "npm test -- --watch" }),
      ).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
  })

  test("unseen pattern → NO_DECISION no-op (lets Claude Code show its dialog)", async () => {
    const layer = Layer.mergeAll(ProjectTest({ root: "/repo" }), ApprovalsTest())
    const d = await Effect.runPromise(
      handlePermissionRequest(
        requestPayload("Bash", { command: "echo hi" }),
      ).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
  })
})
