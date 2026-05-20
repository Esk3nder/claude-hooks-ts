/**
 * Methodology pillar: TDD-first PreToolUse gate (US-1).
 *
 * The promise: with `CLAUDE_HOOKS_TDD_GATE_ENABLED=1`, a Write to a
 * non-test file under `src/**` is denied unless a companion test exists
 * on disk OR was touched in this session. Bootstrap-batch escape: once
 * the test appears in `files_changed`, the implementation Write is
 * allowed.
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

describe("methodology e2e: TDD-first PreToolUse gate", () => {
  test("Write to src/foo.ts with NO companion test → DENIED", async () => {
    const project = withTmpProject("tdd-deny")
    try {
      const sessionId = "tdd-1"
      // Engagement gate must release first → ISA on disk.
      writeIsaFixture(project.root, `.claude-hooks/work/${sessionId}/ISA.md`)
      const decision = await Effect.runPromise(
        handlePreToolUse(
          writePayload(sessionId, project.root, path.join(project.root, "src", "foo.ts")),
        ).pipe(
          Effect.provide(seedSessionRecord(sessionId, engagedPatch(project.root, sessionId))),
          Effect.provide(RuntimeConfigTest({ tddGateEnabled: true })),
        ),
      )
      const out = preToolDecisionOutput(decision)
      expect(out?.permissionDecision).toBe("deny")
      expect(out?.permissionDecisionReason).toContain("TDD gate")
    } finally {
      project.cleanup()
    }
  })

  test("Bootstrap-batch escape: test file in files_changed → impl write ALLOWED", async () => {
    const project = withTmpProject("tdd-bootstrap")
    try {
      const sessionId = "tdd-2"
      writeIsaFixture(project.root, `.claude-hooks/work/${sessionId}/ISA.md`)
      const testFilePath = path.join(project.root, "test", "foo", "bar.test.ts")
      const decision = await Effect.runPromise(
        handlePreToolUse(
          writePayload(
            sessionId,
            project.root,
            path.join(project.root, "src", "foo", "bar.ts"),
          ),
        ).pipe(
          Effect.provide(
            seedSessionRecord(sessionId, {
              ...engagedPatch(project.root, sessionId),
              files_changed: [testFilePath],
            }),
          ),
          Effect.provide(RuntimeConfigTest({ tddGateEnabled: true })),
        ),
      )
      // Allowed — TDD gate sees the companion test in session ledger.
      expect(preToolDecisionOutput(decision)?.permissionDecision).not.toBe("deny")
    } finally {
      project.cleanup()
    }
  })

  test("Gate OFF (default) → write passes through regardless", async () => {
    const project = withTmpProject("tdd-off")
    try {
      const sessionId = "tdd-3"
      writeIsaFixture(project.root, `.claude-hooks/work/${sessionId}/ISA.md`)
      const decision = await Effect.runPromise(
        handlePreToolUse(
          writePayload(sessionId, project.root, path.join(project.root, "src", "foo.ts")),
        ).pipe(
          Effect.provide(seedSessionRecord(sessionId, engagedPatch(project.root, sessionId))),
          Effect.provide(RuntimeConfigTest({ tddGateEnabled: false })),
        ),
      )
      expect(preToolDecisionOutput(decision)?.permissionDecision).not.toBe("deny")
    } finally {
      project.cleanup()
    }
  })
})
