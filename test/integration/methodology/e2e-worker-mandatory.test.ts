/**
 * Methodology pillar: mandatory worker delegation at tier ≥ E4 (US-2).
 *
 * The promise: with `CLAUDE_HOOKS_WORKER_MANDATORY_MODE=strict`, a
 * direct Write at classifier tier ≥ E4 is denied unless a worker is
 * already active for the session. `recommend` returns `ask`. `off`
 * (default) is passthrough.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as path from "node:path"
import { handlePreToolUse } from "../../../src/events/pretool-policy.ts"
import { RuntimeConfigTest } from "../../../src/services/runtime-config.ts"
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

describe("methodology e2e: mandatory worker delegation at E4+", () => {
  test("strict + E5 + no active worker → DENY", async () => {
    const project = withTmpProject("wm-strict")
    try {
      const sessionId = "wm-1"
      writeIsaFixture(project.root, `.claude-hooks/work/${sessionId}/ISA.md`)
      const decision = await Effect.runPromise(
        handlePreToolUse(
          writePayload(sessionId, project.root, path.join(project.root, "src", "foo.ts")),
        ).pipe(
          Effect.provide(
            seedSessionRecord(sessionId, engagedPatch(project.root, sessionId, 5)),
          ),
          Effect.provide(RuntimeConfigTest({ workerMandatoryMode: "strict" })),
        ),
      )
      const out = preToolDecisionOutput(decision)
      expect(out?.permissionDecision).toBe("deny")
      expect(out?.permissionDecisionReason).toContain("worker-mandatory")
    } finally {
      project.cleanup()
    }
  })

  test("recommend + E4 + no active worker → ASK", async () => {
    const project = withTmpProject("wm-recommend")
    try {
      const sessionId = "wm-2"
      writeIsaFixture(project.root, `.claude-hooks/work/${sessionId}/ISA.md`)
      const decision = await Effect.runPromise(
        handlePreToolUse(
          writePayload(sessionId, project.root, path.join(project.root, "src", "foo.ts")),
        ).pipe(
          Effect.provide(
            seedSessionRecord(sessionId, engagedPatch(project.root, sessionId, 4)),
          ),
          Effect.provide(RuntimeConfigTest({ workerMandatoryMode: "recommend" })),
        ),
      )
      expect(preToolDecisionOutput(decision)?.permissionDecision).toBe("ask")
    } finally {
      project.cleanup()
    }
  })

  test("strict + E4 + active worker (starts > stops) → passthrough", async () => {
    const project = withTmpProject("wm-active")
    try {
      const sessionId = "wm-3"
      writeIsaFixture(project.root, `.claude-hooks/work/${sessionId}/ISA.md`)
      const decision = await Effect.runPromise(
        handlePreToolUse(
          writePayload(sessionId, project.root, path.join(project.root, "src", "foo.ts")),
        ).pipe(
          Effect.provide(
            seedSessionRecord(sessionId, {
              ...engagedPatch(project.root, sessionId, 4),
              subagent_starts: ["worker-a"],
              subagent_stops: [],
            }),
          ),
          Effect.provide(RuntimeConfigTest({ workerMandatoryMode: "strict" })),
        ),
      )
      expect(preToolDecisionOutput(decision)?.permissionDecision).not.toBe("deny")
    } finally {
      project.cleanup()
    }
  })

  test("strict + E3 (below threshold) → passthrough", async () => {
    const project = withTmpProject("wm-e3")
    try {
      const sessionId = "wm-4"
      writeIsaFixture(project.root, `.claude-hooks/work/${sessionId}/ISA.md`)
      const decision = await Effect.runPromise(
        handlePreToolUse(
          writePayload(sessionId, project.root, path.join(project.root, "src", "foo.ts")),
        ).pipe(
          Effect.provide(
            seedSessionRecord(sessionId, engagedPatch(project.root, sessionId, 3)),
          ),
          Effect.provide(RuntimeConfigTest({ workerMandatoryMode: "strict" })),
        ),
      )
      expect(preToolDecisionOutput(decision)?.permissionDecision).not.toBe("deny")
    } finally {
      project.cleanup()
    }
  })
})
