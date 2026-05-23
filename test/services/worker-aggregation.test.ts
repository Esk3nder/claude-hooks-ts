import { describe, expect, test } from "bun:test"
import type { WorkerResult, WorkerRun } from "../../src/schema/worker-run.ts"
import {
  summarizeHistoricalWorkerRuns,
  summarizeWorkerRuns,
} from "../../src/services/worker-aggregation.ts"

type WorkerRunWithContract = WorkerRun & {
  readonly contract_version?: string
  readonly contract_hash?: string
}

const workerResult = (
  summary: string,
  verification: WorkerResult["verification"] = [
    {
      check: "worker projection",
      status: "passed",
      evidence: "projection test",
    },
  ],
): WorkerResult => ({
  summary,
  files_relevant: [],
  changes_made: [],
  commands_run: [],
  verification,
  risks: [],
  blockers: [],
  confidence: "high",
})

const run = (
  workerId: string,
  sessionId: string,
  status: WorkerRun["status"],
  overrides: Partial<WorkerRunWithContract> = {},
): WorkerRunWithContract => ({
  worker_id: workerId,
  session_id: sessionId,
  agent_type: "executor",
  mode: "write-allowed",
  status,
  prompt_hash: "prompt-shape-1",
  scope: "src/services/worker-aggregation.ts",
  created_at: `2026-05-13T00:0${workerId.at(-1) ?? "0"}:00.000Z`,
  attempts: 1,
  ...overrides,
})

describe("worker aggregation projections", () => {
  test("detects repeated failures across sessions for the same contract scope and prompt shape", () => {
    const summary = summarizeHistoricalWorkerRuns(
      [
        run("worker-1", "session-a", "failed", {
          contract_version: "v2",
          contract_hash: "contract-hash-1",
          failure_reason: "TypeError: Cannot read property 'id'",
        }),
        run("worker-2", "session-b", "failed", {
          contract_version: "v2",
          contract_hash: "contract-hash-1",
          failure_reason: "TypeError: Cannot read property 'id'",
        }),
        run("worker-3", "session-c", "failed", {
          contract_version: "v2",
          contract_hash: "contract-hash-1",
          failure_reason: "timeout waiting for event store lock",
        }),
      ],
      { repeatedThreshold: 2 },
    )

    expect(summary.repeated_failures).toEqual([
      {
        key: {
          agent_type: "executor",
          scope: "src/services/worker-aggregation.ts",
          prompt_hash: "prompt-shape-1",
          contract_version: "v2",
          contract_hash: "contract-hash-1",
        },
        pattern: "failure:TypeError: Cannot read property 'id'",
        count: 2,
        worker_ids: ["worker-1", "worker-2"],
        session_ids: ["session-a", "session-b"],
      },
    ])
  })

  test("does not merge repeated failure patterns across different contract hashes", () => {
    const summary = summarizeHistoricalWorkerRuns(
      [
        run("worker-1", "session-a", "failed", {
          contract_version: "v2",
          contract_hash: "contract-hash-1",
          failure_reason: "TypeError: Cannot read property 'id'",
        }),
        run("worker-2", "session-b", "failed", {
          contract_version: "v2",
          contract_hash: "contract-hash-2",
          failure_reason: "TypeError: Cannot read property 'id'",
        }),
      ],
      { repeatedThreshold: 2 },
    )

    expect(summary.groups).toHaveLength(2)
    expect(summary.repeated_failures).toEqual([])
  })

  test("summarizes successful verified runs separately from repeated failed shapes", () => {
    const summary = summarizeHistoricalWorkerRuns(
      [
        run("worker-1", "session-a", "failed", {
          failure_reason: "dependency install failed",
        }),
        run("worker-2", "session-b", "failed", {
          failure_reason: "dependency install failed",
        }),
        run("worker-3", "session-c", "completed", {
          result: workerResult("verified completion"),
        }),
      ],
      { repeatedThreshold: 2 },
    )

    expect(summary.repeated_failures).toHaveLength(1)
    expect(summary.successful_verified_runs).toEqual([
      {
        key: {
          agent_type: "executor",
          scope: "src/services/worker-aggregation.ts",
          prompt_hash: "prompt-shape-1",
        },
        count: 1,
        worker_ids: ["worker-3"],
        session_ids: ["session-c"],
        verification_patterns: ["passed:worker projection"],
      },
    ])
    expect(summary.groups[0]?.status_counts).toMatchObject({
      completed: 1,
      failed: 2,
    })
  })

  test("counts a repeated failure pattern once per worker run", () => {
    const duplicateBlocker = workerResult("blocked")
    const summary = summarizeHistoricalWorkerRuns(
      [
        run("worker-1", "session-a", "blocked", {
          blocked_reason: "dependency install failed",
          result: {
            ...duplicateBlocker,
            blockers: ["dependency install failed"],
          },
        }),
      ],
      { repeatedThreshold: 2 },
    )

    expect(summary.repeated_failures).toEqual([])
  })

  test("limits historical projection to the last requested runs and sessions", () => {
    const summary = summarizeHistoricalWorkerRuns(
      [
        run("worker-4", "session-c", "failed", {
          stopped_at: "2026-05-13T00:04:00.000Z",
          failure_reason: "dependency install failed",
        }),
        run("worker-1", "old-session", "failed", {
          stopped_at: "2026-05-13T00:01:00.000Z",
          failure_reason: "old failure should be outside the session window",
        }),
        run("worker-3", "session-b", "failed", {
          stopped_at: "2026-05-13T00:03:00.000Z",
          failure_reason: "dependency install failed",
        }),
        run("worker-2", "session-a", "failed", {
          stopped_at: "2026-05-13T00:02:00.000Z",
          failure_reason: "dependency install failed",
        }),
      ],
      { lastRuns: 3, lastSessions: 2, repeatedThreshold: 2 },
    )

    expect(summary.runs_considered).toBe(2)
    expect(summary.sessions_considered).toEqual(["session-b", "session-c"])
    expect(summary.repeated_failures[0]?.worker_ids).toEqual(["worker-3", "worker-4"])
  })

  test("keeps summarizeWorkerRuns session behavior unchanged", () => {
    const summary = summarizeWorkerRuns("session-a", [
      run("worker-1", "session-a", "completed", {
        result: workerResult("verified completion"),
        patch_changed_files: ["src/services/worker-aggregation.ts"],
      }),
      run("worker-2", "session-a", "failed", {
        failure_reason: "integration failed",
      }),
    ])

    expect(summary).toMatchObject({
      session_id: "session-a",
      workers_total: 2,
      completed: 1,
      failed: 1,
      files_changed: ["src/services/worker-aggregation.ts"],
      ready_for_integration: false,
    })
    expect(summary.failed_worker_ids).toEqual(["worker-2"])
    expect(summary.blockers).toContain("integration failed")
  })
})
