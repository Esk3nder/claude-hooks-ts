import { describe, expect, test } from "bun:test"
import type { WorkerResult, WorkerRun } from "../../src/schema/worker-run.ts"
import {
  CURRENT_WORKER_CONTRACT_HASH,
  CURRENT_WORKER_CONTRACT_VERSION,
} from "../../src/policies/worker-contract.ts"
import {
  evaluateWorkerReplayCandidate,
  isWorkerRunSafeForAutoReplay,
} from "../../src/policies/worker-replay-cache.ts"

type ReplayableWorkerRun = WorkerRun & {
  readonly contract_version?: string
  readonly contract_hash?: string
}

const verifiedResult = (overrides: Partial<WorkerResult> = {}): WorkerResult => ({
  summary: "read-only worker found the relevant files",
  files_relevant: [
    {
      path: "src/policies/worker-replay-cache.ts",
      reason: "candidate policy under test",
    },
  ],
  changes_made: [],
  commands_run: [
    {
      command: "bun test test/policies/worker-replay-cache.test.ts",
      exit_code: 0,
      result: "passed",
    },
  ],
  verification: [
    {
      check: "policy tests",
      status: "passed",
      evidence: "bun test passed",
    },
  ],
  risks: [],
  blockers: [],
  confidence: "high",
  ...overrides,
})

const workerRun = (
  overrides: Partial<ReplayableWorkerRun> = {},
): ReplayableWorkerRun => {
  const result = verifiedResult()
  return {
    worker_id: "worker-1",
    session_id: "session-1",
    agent_id: "agent-1",
    agent_type: "Explore",
    mode: "read-only",
    status: "completed",
    prompt_hash: "prompt-hash",
    contract_version: CURRENT_WORKER_CONTRACT_VERSION,
    contract_hash: CURRENT_WORKER_CONTRACT_HASH,
    scope: "src/**",
    created_at: "2026-05-13T00:00:00.000Z",
    stopped_at: "2026-05-13T00:01:00.000Z",
    attempts: 1,
    result,
    output: result,
    ...overrides,
  }
}

const query = {
  prompt_hash: "prompt-hash",
  scope: "src/**",
  agent_type: "Explore",
}

describe("worker replay cache policy", () => {
  test("accepts a completed read-only verified structured run as auto-replayable", () => {
    const decision = evaluateWorkerReplayCandidate(workerRun(), query)

    expect(decision.kind).toBe("auto-replayable")
    expect(isWorkerRunSafeForAutoReplay(workerRun(), query)).toBe(true)
    if (decision.kind === "auto-replayable") {
      expect(decision.result.summary).toContain("read-only worker")
    }
  })

  test("write-allowed runs can only be advisory prior-result candidates", () => {
    const run = workerRun({
      agent_type: "executor",
      mode: "write-allowed",
      result: verifiedResult({
        changes_made: [
          {
            path: "src/file.ts",
            summary: "changed implementation",
            diff_ref: "patch.diff",
          },
        ],
      }),
      patch_path: ".claude-hooks/work/worker-1.patch",
      patch_changed_files: ["src/file.ts"],
    })
    const decision = evaluateWorkerReplayCandidate(run, {
      ...query,
      agent_type: "executor",
    })

    expect(decision.kind).toBe("advisory-only")
    expect(
      isWorkerRunSafeForAutoReplay(run, { ...query, agent_type: "executor" }),
    ).toBe(false)
  })

  test("rejects contract version and hash mismatches when requested", () => {
    const run = workerRun({
      contract_version: "v1",
      contract_hash: "contract-a",
    })

    expect(
      evaluateWorkerReplayCandidate(run, {
        ...query,
        contract_version: "v2",
      }).kind,
    ).toBe("rejected")
    expect(
      evaluateWorkerReplayCandidate(run, {
        ...query,
        contract_hash: "contract-b",
      }).kind,
    ).toBe("rejected")
  })

  test("defaults replay queries to the current contract metadata", () => {
    const {
      contract_version: _contractVersion,
      contract_hash: _contractHash,
      ...legacyRun
    } = workerRun()
    void _contractVersion
    void _contractHash

    const decision = evaluateWorkerReplayCandidate(legacyRun, query)

    expect(decision.kind).toBe("rejected")
    if (decision.kind === "rejected") {
      expect(decision.reason).toBe("contract_mismatch")
    }
  })

  test("rejects failed, unstructured, or noisy runs", () => {
    expect(
      evaluateWorkerReplayCandidate(workerRun({ status: "failed" }), query).kind,
    ).toBe("rejected")
    expect(
      evaluateWorkerReplayCandidate(
        workerRun({
          result: undefined,
          output: undefined,
          result_unstructured: true,
        }),
        query,
      ).kind,
    ).toBe("rejected")
    expect(
      evaluateWorkerReplayCandidate(
        workerRun({
          result: verifiedResult({
            commands_run: [
              {
                command: "bun test",
                exit_code: 1,
                result: "failed",
              },
            ],
          }),
        }),
        query,
      ).kind,
    ).toBe("rejected")
  })

  test("rejects read-only replay candidates with reported or captured changes", () => {
    const reported = evaluateWorkerReplayCandidate(
      workerRun({
        result: verifiedResult({
          changes_made: [{ path: "src/file.ts", summary: "changed" }],
        }),
      }),
      query,
    )
    const patchPath = evaluateWorkerReplayCandidate(
      workerRun({ patch_path: ".claude-hooks/work/worker-1.patch" }),
      query,
    )
    const patchFiles = evaluateWorkerReplayCandidate(
      workerRun({ patch_changed_files: ["src/file.ts"] }),
      query,
    )

    expect(reported.kind).toBe("rejected")
    expect(patchPath.kind).toBe("rejected")
    expect(patchFiles.kind).toBe("rejected")
    if (reported.kind === "rejected") expect(reported.reason).toBe("read_only_changed_files")
    if (patchPath.kind === "rejected") expect(patchPath.reason).toBe("read_only_changed_files")
    if (patchFiles.kind === "rejected") expect(patchFiles.reason).toBe("read_only_changed_files")
  })

  test("rejects runs with risks or blockers as noisy replay candidates", () => {
    const risky = evaluateWorkerReplayCandidate(
      workerRun({ result: verifiedResult({ risks: ["needs manual review"] }) }),
      query,
    )
    const blocked = evaluateWorkerReplayCandidate(
      workerRun({ result: verifiedResult({ blockers: ["missing dependency"] }) }),
      query,
    )

    expect(risky.kind).toBe("rejected")
    expect(blocked.kind).toBe("rejected")
    if (risky.kind === "rejected") expect(risky.reason).toBe("noisy_result")
    if (blocked.kind === "rejected") expect(blocked.reason).toBe("noisy_result")
  })

  test("rejects unverified and not-run verification results by default", () => {
    expect(
      evaluateWorkerReplayCandidate(
        workerRun({ result: verifiedResult({ verification: [] }) }),
        {
          prompt_hash: "prompt-hash",
          scope: "src/**",
          agent_type: "Explore",
        },
      ).kind,
    ).toBe("rejected")
    expect(
      evaluateWorkerReplayCandidate(
        workerRun({
          result: verifiedResult({
            verification: [{ check: "not run", status: "not_run", evidence: "skipped" }],
          }),
        }),
        query,
      ).kind,
    ).toBe("rejected")
  })
})
