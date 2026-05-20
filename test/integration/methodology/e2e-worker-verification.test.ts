/**
 * Methodology pillar: worker behavioral verification replay (US-1c).
 *
 * The promise: when a worker reports `verification: { check, status: "passed" }`
 * but the parent's probe for that same check returns false at
 * SubagentStop, the gate blocks. Closes the "worker said so" trust hole.
 *
 * Stands up a tmpdir with a `.claude-hooks/probes.ts` whose `typecheck`
 * probe deliberately returns false. A worker output that CLAIMS
 * `typecheck: passed` is fed to handleSubagentStop. Verdict must be block
 * with `verification_replay_failed`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { handleSubagentStop } from "../../../src/events/subagent-scope-gate.ts"
import { EventStoreLive } from "../../../src/services/event-store.ts"
import { NormalizedHookEvent } from "../../../src/schema/normalized.ts"
import { RuntimeConfigTest } from "../../../src/services/runtime-config.ts"
import { SessionStateTest } from "../../../src/services/session-state.ts"
import {
  WorkerRuns,
  WorkerRunsLive,
  scopedWorkerRunId,
} from "../../../src/services/worker-runs.ts"
import { withTmpProject } from "./_helpers.ts"

const decode = (raw: unknown): NormalizedHookEvent =>
  Schema.decodeUnknownSync(NormalizedHookEvent)(raw)

// A probes.ts that defines `typecheck` to return FALSE — the parent's
// replay will disagree with a worker claiming `typecheck: passed`.
const PROBES_FAILS = `export const probes = {
  typecheck: () => false,
}
`

const PROBES_PASSES = `export const probes = {
  typecheck: () => true,
}
`

// Read-only worker output: no changes_made (avoids the earlier
// write-worker patch-capture gate so we can isolate the replay path).
// The verification[] claim is the input to US-1c's replay.
const workerOutputClaimsTypecheckPassed = JSON.stringify({
  summary: "investigated; reported findings",
  files_relevant: [{ path: "src/foo.ts", reason: "investigated" }],
  changes_made: [],
  commands_run: [],
  verification: [
    { check: "typecheck", status: "passed", evidence: "worker says so" },
  ],
  risks: [],
  blockers: [],
  confidence: "high",
})

const stopPayload = (cwd: string, output: string): NormalizedHookEvent =>
  decode({
    _tag: "SubagentStop",
    session_id: "wv-session",
    hook_event_name: "SubagentStop",
    agent_id: "a1",
    agent_type: "general-purpose",
    cwd,
    output,
    // worker contract marker so the gate recognizes this as a contracted worker
    prompt: "<claude-hooks-worker-contract>\nscope: src/**",
  })

const setupWorker = (workerId: string) =>
  Effect.gen(function* () {
    const runs = yield* WorkerRuns
    yield* runs.createQueued({
      worker_id: workerId,
      session_id: "wv-session",
      agent_id: "a1",
      agent_type: "general-purpose",
      mode: "read-only",
      prompt_hash: "prompt-hash",
      scope: "src/**",
    })
    yield* runs.markRunning(workerId)
  })

describe("methodology e2e: worker behavioral verification replay (US-1c)", () => {
  test("worker claims typecheck=passed + probe returns false → BLOCK", async () => {
    const project = withTmpProject("wv-disagree")
    try {
      fs.mkdirSync(path.join(project.root, ".claude-hooks"), { recursive: true })
      fs.writeFileSync(
        path.join(project.root, ".claude-hooks", "probes.ts"),
        PROBES_FAILS,
        "utf-8",
      )
      const workerId = scopedWorkerRunId("wv-session", "a1")
      const layer = Layer.mergeAll(
        SessionStateTest(),
        Layer.provide(WorkerRunsLive(project.root), EventStoreLive),
        RuntimeConfigTest({ workerWriteIsolation: "none" }),
      )
      const decision = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupWorker(workerId)
          return yield* handleSubagentStop(
            stopPayload(project.root, workerOutputClaimsTypecheckPassed),
          )
        }).pipe(Effect.provide(layer)),
      )
      // Block decision shape.
      expect("decision" in decision).toBe(true)
      if ("decision" in decision) {
        expect(decision.decision).toBe("block")
        expect(decision.reason).toContain("verification_replay_failed")
        expect(decision.reason).toContain("typecheck")
      }
    } finally {
      project.cleanup()
    }
  })

  test("worker claims typecheck=passed + probe returns true → no replay block", async () => {
    const project = withTmpProject("wv-agree")
    try {
      fs.mkdirSync(path.join(project.root, ".claude-hooks"), { recursive: true })
      fs.writeFileSync(
        path.join(project.root, ".claude-hooks", "probes.ts"),
        PROBES_PASSES,
        "utf-8",
      )
      const workerId = scopedWorkerRunId("wv-session", "a1")
      const layer = Layer.mergeAll(
        SessionStateTest(),
        Layer.provide(WorkerRunsLive(project.root), EventStoreLive),
        RuntimeConfigTest({ workerWriteIsolation: "none" }),
      )
      const decision = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupWorker(workerId)
          return yield* handleSubagentStop(
            stopPayload(project.root, workerOutputClaimsTypecheckPassed),
          )
        }).pipe(Effect.provide(layer)),
      )
      // The verification-replay gate must NOT block. Other gates may
      // still fire (e.g., write-worker without captured patch), so we
      // assert the absence of the specific replay-failed reason.
      if ("decision" in decision && decision.decision === "block") {
        expect(decision.reason).not.toContain("verification_replay_failed")
      }
    } finally {
      project.cleanup()
    }
  })
})
