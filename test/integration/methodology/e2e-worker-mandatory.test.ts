/**
 * Methodology pillar: mandatory worker delegation at tier ≥ E4 (US-2).
 *
 * The promise: with `CLAUDE_HOOKS_WORKER_MANDATORY_MODE=strict`, a
 * direct Write at classifier tier ≥ E4 is denied unless a worker is
 * already active for the session. `recommend` returns `ask`. `off`
 * (default) is passthrough.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as path from "node:path"
import { handlePreToolUse } from "../../../src/events/pretool-policy.ts"
import { RuntimeConfigTest } from "../../../src/services/runtime-config.ts"
import { EventStoreLive } from "../../../src/services/event-store.ts"
import { EventStoreError } from "../../../src/schema/errors.ts"
import {
  WorkerRuns,
  WorkerRunsLive,
} from "../../../src/services/worker-runs.ts"
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

  // P0-1 regression: previously, `subagent_starts.length >
  // subagent_stops.length` was treated as proof a worker was active and
  // the gate returned `allow`. A dropped SubagentStop append (the
  // catch-all in subagent-scope-gate just reports and swallows the
  // error) left this delta permanently positive, so the parent silently
  // regained direct-write ability for the rest of the session. Fix:
  // derive the active count from the worker-runs ledger when the
  // service is in context. Test asserts the two layers disagree
  // (subagent_starts seeded as if a worker had started but the runs
  // ledger holds no active record) and the gate denies, proving the
  // runs ledger is now authoritative.
  test("strict + E5 + stale subagent_starts but no active runs → DENY", async () => {
    const project = withTmpProject("wm-stale-stop")
    try {
      const sessionId = "wm-stale"
      writeIsaFixture(project.root, `.claude-hooks/work/${sessionId}/ISA.md`)
      const layer = Layer.mergeAll(
        seedSessionRecord(sessionId, {
          ...engagedPatch(project.root, sessionId, 5),
          // Pre-fix: this alone made activeWorkerCount = 1 → allow.
          subagent_starts: ["w1:dropped-stop"],
          subagent_stops: [],
        }),
        RuntimeConfigTest({ workerMandatoryMode: "strict" }),
        // Provide WorkerRuns with an empty ledger — no runs were ever
        // created, mirroring a state where the start event was recorded
        // but the runs.createQueued / markRunning chain never ran (or
        // the run already reached a terminal status and the stop append
        // failed to land).
        Layer.provide(WorkerRunsLive(project.root), EventStoreLive),
      )
      const decision = await Effect.runPromise(
        handlePreToolUse(
          writePayload(sessionId, project.root, path.join(project.root, "src", "foo.ts")),
        ).pipe(Effect.provide(layer)),
      )
      const out = preToolDecisionOutput(decision)
      expect(out?.permissionDecision).toBe("deny")
      expect(out?.permissionDecisionReason).toContain("worker-mandatory")
    } finally {
      project.cleanup()
    }
  })

  // P0-1 complement: same wiring, but a `running` worker run exists in
  // the ledger. Even with `subagent_starts` empty (the legacy signal
  // would say 0), the ledger-derived count is 1 and the gate allows.
  test("strict + E5 + empty subagent_starts but a running run → passthrough", async () => {
    const project = withTmpProject("wm-ledger-active")
    try {
      const sessionId = "wm-ledger"
      writeIsaFixture(project.root, `.claude-hooks/work/${sessionId}/ISA.md`)
      const layer = Layer.mergeAll(
        seedSessionRecord(sessionId, {
          ...engagedPatch(project.root, sessionId, 5),
          subagent_starts: [],
          subagent_stops: [],
        }),
        RuntimeConfigTest({ workerMandatoryMode: "strict" }),
        Layer.provide(WorkerRunsLive(project.root), EventStoreLive),
      )
      const decision = await Effect.runPromise(
        Effect.gen(function* () {
          const runs = yield* WorkerRuns
          yield* runs.createQueued({
            worker_id: "w-ledger-active",
            session_id: sessionId,
            agent_id: "a1",
            agent_type: "general-purpose",
            mode: "write-allowed",
            prompt_hash: "h",
            scope: "src/**",
          })
          yield* runs.markRunning("w-ledger-active")
          return yield* handlePreToolUse(
            writePayload(sessionId, project.root, path.join(project.root, "src", "foo.ts")),
          )
        }).pipe(Effect.provide(layer)),
      )
      expect(preToolDecisionOutput(decision)?.permissionDecision).not.toBe("deny")
    } finally {
      project.cleanup()
    }
  })

  // A-FU1 (review follow-up): ledger-read failure must fall back to
  // the legacy starts-stops signal, not zero the count. Zeroing would
  // deny *all* direct writes during a transient ledger outage; falling
  // back keeps the gate operational on the same signal the codebase
  // ran on for months. The hook-failure record is also expected (not
  // asserted directly here — observability is covered by the
  // reportHookFailure path's own tests; this asserts the decision
  // outcome that the fallback produces).
  test("strict + E5 + WorkerRuns.forSession errors → falls back to starts-stops", async () => {
    const project = withTmpProject("wm-ledger-fail")
    try {
      const sessionId = "wm-fail"
      writeIsaFixture(project.root, `.claude-hooks/work/${sessionId}/ISA.md`)
      // Stub WorkerRuns whose forSession returns Left. Other methods
      // are intentionally unimplemented — handlePreToolUse only calls
      // forSession when worker-mandatory mode is non-off.
      const failingRuns: Layer.Layer<WorkerRuns> = Layer.succeed(
        WorkerRuns,
        WorkerRuns.of({
          forSession: () =>
            Effect.fail(
              new EventStoreError({
                op: "tail",
                stream: "worker-runs",
                path: "/dev/null",
                message: "simulated ledger read failure for A-FU1 test",
              }),
            ),
          // Methods below should not be reached by the gate's
          // active-count derivation. Effect.die signals a test bug if
          // they ever are.
          createQueued: () => Effect.die("createQueued not stubbed"),
          markRunning: () => Effect.die("markRunning not stubbed"),
          recordBaselineRef: () =>
            Effect.die("recordBaselineRef not stubbed"),
          markBlocked: () => Effect.die("markBlocked not stubbed"),
          complete: () => Effect.die("complete not stubbed"),
          markIntegrated: () => Effect.die("markIntegrated not stubbed"),
          markIntegrationRejected: () =>
            Effect.die("markIntegrationRejected not stubbed"),
          fail: () => Effect.die("fail not stubbed"),
          cancel: () => Effect.die("cancel not stubbed"),
          get: () => Effect.die("get not stubbed"),
          findByAgent: () => Effect.die("findByAgent not stubbed"),
          forParent: () => Effect.die("forParent not stubbed"),
          list: () => Effect.die("list not stubbed"),
          stream: () => Effect.die("stream not stubbed") as never,
        }),
      )
      const layer = Layer.mergeAll(
        seedSessionRecord(sessionId, {
          ...engagedPatch(project.root, sessionId, 5),
          // Starts-stops would say count=1 (1 active) → allow. The
          // failing ledger read MUST fall back to this signal, not
          // zero it out.
          subagent_starts: ["w1:starts-stops-fallback"],
          subagent_stops: [],
        }),
        RuntimeConfigTest({ workerMandatoryMode: "strict" }),
        failingRuns,
      )
      const decision = await Effect.runPromise(
        handlePreToolUse(
          writePayload(
            sessionId,
            project.root,
            path.join(project.root, "src", "foo.ts"),
          ),
        ).pipe(Effect.provide(layer)),
      )
      // Fallback path → starts-stops count is 1 → allow (NOT deny).
      // If the code had zeroed the count on error, this would deny.
      expect(preToolDecisionOutput(decision)?.permissionDecision).not.toBe(
        "deny",
      )
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
