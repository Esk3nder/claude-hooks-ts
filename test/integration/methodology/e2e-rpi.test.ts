/**
 * Methodology pillar: RPI (Read-Plan-Implement) — engagement gate.
 *
 * The promise: when the classifier puts a session at ALGORITHM tier ≥ 3,
 * any attempt to write/edit a non-ISA file is denied until the expected
 * ISA file exists on disk. Once the ISA is written, the gate releases
 * for non-ISA targets.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as path from "node:path"
import { handlePreToolUse } from "../../../src/events/pretool-policy.ts"
import {
  decodePayload,
  engagedPatch,
  preToolDecisionOutput,
  seedSessionRecord,
  withTmpProject,
  writeIsaFixture,
} from "./_helpers.ts"

const writePayload = (sessionId: string, cwd: string, file: string) =>
  decodePayload({
    _tag: "PreToolUse",
    session_id: sessionId,
    hook_event_name: "PreToolUse",
    cwd,
    tool_name: "Write",
    tool_input: { file_path: file, content: "x" },
  })

describe("methodology e2e: RPI engagement gate", () => {
  test("E3 session, no ISA on disk → Write to src/foo.ts is DENIED", async () => {
    const project = withTmpProject("rpi-deny")
    try {
      const sessionId = "rpi-1"
      const decision = await Effect.runPromise(
        handlePreToolUse(
          writePayload(sessionId, project.root, path.join(project.root, "src", "foo.ts")),
        ).pipe(
          Effect.provide(seedSessionRecord(sessionId, engagedPatch(project.root, sessionId))),
        ),
      )
      const out = preToolDecisionOutput(decision)
      expect(out?.hookEventName).toBe("PreToolUse")
      expect(out?.permissionDecision).toBe("deny")
      expect(out?.permissionDecisionReason).toContain("ISA required")
    } finally {
      project.cleanup()
    }
  })

  test("E3 session, ISA EXISTS on disk → Write to non-ISA path passes through", async () => {
    const project = withTmpProject("rpi-allow")
    try {
      const sessionId = "rpi-2"
      // Write the expected ISA so the gate releases.
      writeIsaFixture(project.root, `.claude-hooks/work/${sessionId}/ISA.md`)
      const decision = await Effect.runPromise(
        handlePreToolUse(
          writePayload(sessionId, project.root, path.join(project.root, "src", "foo.ts")),
        ).pipe(
          Effect.provide(seedSessionRecord(sessionId, engagedPatch(project.root, sessionId))),
        ),
      )
      // No PreToolUse decision = passthrough. The destructive-paths /
      // protected-paths checks will fire on src/foo.ts (which is a normal
      // path), so passthrough = empty/no decision.
      const out = preToolDecisionOutput(decision)
      expect(out?.permissionDecision).not.toBe("deny")
    } finally {
      project.cleanup()
    }
  })
})
