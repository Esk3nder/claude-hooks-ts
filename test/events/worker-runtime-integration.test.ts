import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { handlePreToolUse } from "../../src/events/pretool-policy.ts"
import { handleTaskCompleted } from "../../src/events/task-integrity.ts"
import {
  handleSubagentStart,
  handleSubagentStop,
} from "../../src/events/subagent-scope-gate.ts"
import {
  NormalizedHookEvent,
  type NormalizedSubagentStart,
  type NormalizedSubagentStop,
} from "../../src/schema/normalized.ts"
import type { WorkerResult } from "../../src/schema/worker-run.ts"
import { AppTest } from "../../src/layers/test.ts"
import { SessionState } from "../../src/services/session-state.ts"
import { WorkerAggregation } from "../../src/services/worker-aggregation.ts"
import { WorkerRuns } from "../../src/services/worker-runs.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(NormalizedHookEvent)(raw)

const startPayload = (
  agentType: string,
  agentId: string,
  prompt = "Scope: src/allowed/**\nDo the delegated task.",
): NormalizedSubagentStart =>
  decode({
    _tag: "SubagentStart",
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    agent_type: agentType,
    agent_id: agentId,
    prompt,
    cwd: "/repo",
  }) as NormalizedSubagentStart

const stopPayload = (
  agentType: string,
  agentId: string,
  output: string,
): NormalizedSubagentStop =>
  decode({
    _tag: "SubagentStop",
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    agent_type: agentType,
    agent_id: agentId,
    output,
    cwd: "/repo",
  }) as NormalizedSubagentStop

const preTool = (
  agentId: string,
  toolName: string,
  toolInput: unknown,
) =>
  ({
    _tag: "PreToolUse" as const,
    hook_event_name: "PreToolUse" as const,
    session_id: "session-1",
    agent_id: agentId,
    tool_name: toolName,
    tool_input: toolInput,
    cwd: "/repo",
  })

const uncorrelatedPreTool = (
  toolName: string,
  toolInput: unknown,
) =>
  ({
    _tag: "PreToolUse" as const,
    hook_event_name: "PreToolUse" as const,
    session_id: "session-1",
    tool_name: toolName,
    tool_input: toolInput,
    cwd: "/repo",
  })

const workerResult = (summary = "done"): WorkerResult => ({
  summary,
  files_relevant: [
    {
      path: "src/allowed/file.ts",
      reason: "changed by worker",
    },
  ],
  changes_made: [
    {
      path: "src/allowed/file.ts",
      summary: "updated worker-owned file",
    },
  ],
  commands_run: [
    {
      command: "bun test",
      exit_code: 0,
      result: "passed",
    },
  ],
  verification: [
    {
      check: "worker integration",
      status: "passed",
      evidence: "structured result decoded",
    },
  ],
  risks: [],
  blockers: [],
  confidence: "high",
})

const readOnlyWorkerResult = (summary = "inspected"): WorkerResult => ({
  ...workerResult(summary),
  changes_made: [],
  commands_run: [],
  verification: [
    {
      check: "inspection",
      status: "passed",
      evidence: "read-only worker inspected files without edits",
    },
  ],
})

const taskCompletedPayload = (taskId = "parent-task-1") =>
  ({
    _tag: "TaskCompleted" as const,
    hook_event_name: "TaskCompleted" as const,
    session_id: "session-1",
    task_id: taskId,
    cwd: "/repo",
  })

describe("worker runtime hook integration", () => {
  test("SubagentStart → SubagentStop persists completed typed WorkerRun", async () => {
    const latest = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleSubagentStart(startPayload("Explore", "agent-1"))
        const decision = yield* handleSubagentStop(
          stopPayload("Explore", "agent-1", JSON.stringify(readOnlyWorkerResult())),
        )
        const runs = yield* WorkerRuns
        return {
          decision,
          latest: yield* runs.get("agent-1"),
        }
      }).pipe(Effect.provide(AppTest)),
    )

    expect(latest.decision).toEqual({})
    expect(latest.latest?.status).toBe("completed")
    expect(latest.latest?.mode).toBe("read-only")
    expect(latest.latest?.output?.confidence).toBe("high")
    expect(latest.latest?.result?.summary).toBe("inspected")
  })

  test("SubagentStop blocks malformed worker output when structured results are required", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleSubagentStart(startPayload("Explore", "agent-bad"))
        const decision = yield* handleSubagentStop(
          stopPayload("Explore", "agent-bad", "not json"),
        )
        const runs = yield* WorkerRuns
        return {
          decision,
          latest: yield* runs.get("agent-bad"),
        }
      }).pipe(Effect.provide(AppTest)),
    )

    expect("decision" in result.decision).toBe(true)
    if ("decision" in result.decision) {
      expect(result.decision.decision).toBe("block")
      expect(result.decision.reason).toContain("WorkerResult")
    }
    expect(result.latest?.status).toBe("blocked")
    expect(result.latest?.blocked_reason).toContain("WorkerResult")
  })

  test("SubagentStop blocks read-only workers that report file changes", async () => {
    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleSubagentStart(startPayload("Explore", "agent-readonly-changed"))
        return yield* handleSubagentStop(
          stopPayload("Explore", "agent-readonly-changed", JSON.stringify(workerResult("changed"))),
        )
      }).pipe(Effect.provide(AppTest)),
    )

    expect("decision" in decision).toBe(true)
    if ("decision" in decision) {
      expect(decision.decision).toBe("block")
      expect(decision.reason).toContain("read-only worker reported changes_made")
    }
  })

  test("SubagentStop blocks write workers that changed files without passed verification", async () => {
    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleSubagentStart(startPayload("executor", "agent-unverified"))
        return yield* handleSubagentStop(
          stopPayload(
            "executor",
            "agent-unverified",
            JSON.stringify({
              ...workerResult("unverified"),
              verification: [
                {
                  check: "unit",
                  status: "failed",
                  evidence: "failed",
                },
              ],
            }),
          ),
        )
      }).pipe(Effect.provide(AppTest)),
    )

    expect("decision" in decision).toBe(true)
    if ("decision" in decision) {
      expect(decision.decision).toBe("block")
      expect(decision.reason).toContain("verification not passed")
    }
  })

  test("SubagentStop blocks write workers that report changes without an isolated patch", async () => {
    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleSubagentStart(startPayload("executor", "agent-unisolated"))
        return yield* handleSubagentStop(
          stopPayload("executor", "agent-unisolated", JSON.stringify(workerResult("unisolated"))),
        )
      }).pipe(Effect.provide(AppTest)),
    )

    expect("decision" in decision).toBe(true)
    if ("decision" in decision) {
      expect(decision.decision).toBe("block")
      expect(decision.reason).toContain("captured isolated patch")
    }
  })

  test("read-only worker write attempts are denied by correlated agent_id", async () => {
    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleSubagentStart(startPayload("Explore", "agent-1"))
        return yield* handlePreToolUse(
          preTool("agent-1", "Write", {
            file_path: "src/allowed/file.ts",
            content: "nope",
          }),
        )
      }).pipe(Effect.provide(AppTest)),
    )

    expect("hookSpecificOutput" in decision).toBe(true)
    if ("hookSpecificOutput" in decision) {
      const output = decision.hookSpecificOutput as {
        readonly permissionDecision: string
        readonly permissionDecisionReason: string
      }
      expect(output.permissionDecision).toBe("deny")
      expect(output.permissionDecisionReason).toContain("read-only")
    }
  })

  test("uncorrelated write-capable tools fail closed while active workers exist", async () => {
    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleSubagentStart(startPayload("executor", "agent-active"))
        return yield* handlePreToolUse(
          uncorrelatedPreTool("Write", {
            file_path: "src/allowed/file.ts",
            content: "no correlation",
          }),
        )
      }).pipe(Effect.provide(AppTest)),
    )

    expect("hookSpecificOutput" in decision).toBe(true)
    if ("hookSpecificOutput" in decision) {
      const output = decision.hookSpecificOutput as {
        readonly permissionDecision: string
        readonly permissionDecisionReason: string
      }
      expect(output.permissionDecision).toBe("deny")
      expect(output.permissionDecisionReason).toContain("no worker correlation")
    }
  })

  test("read-only workers cannot run mutating git commands through Bash", async () => {
    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleSubagentStart(startPayload("Explore", "agent-git"))
        return yield* handlePreToolUse(
          preTool("agent-git", "Bash", {
            command: "git add src/allowed/file.ts",
          }),
        )
      }).pipe(Effect.provide(AppTest)),
    )

    expect("hookSpecificOutput" in decision).toBe(true)
    if ("hookSpecificOutput" in decision) {
      const output = decision.hookSpecificOutput as {
        readonly permissionDecision: string
        readonly permissionDecisionReason: string
      }
      expect(output.permissionDecision).toBe("deny")
      expect(output.permissionDecisionReason).toContain("git mutation")
    }
  })

  test("write worker cannot write outside assigned scope", async () => {
    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleSubagentStart(startPayload("executor", "agent-1"))
        return yield* handlePreToolUse(
          preTool("agent-1", "Write", {
            file_path: "src/other/file.ts",
            content: "outside scope",
          }),
        )
      }).pipe(Effect.provide(AppTest)),
    )

    expect("hookSpecificOutput" in decision).toBe(true)
    if ("hookSpecificOutput" in decision) {
      const output = decision.hookSpecificOutput as {
        readonly permissionDecision: string
        readonly permissionDecisionReason: string
      }
      expect(output.permissionDecision).toBe("deny")
      expect(output.permissionDecisionReason).toContain("outside assigned scope")
    }
  })

  test("write worker may write inside assigned scope", async () => {
    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleSubagentStart(startPayload("executor", "agent-1"))
        return yield* handlePreToolUse(
          preTool("agent-1", "Write", {
            file_path: "src/allowed/file.ts",
            content: "inside scope",
          }),
        )
      }).pipe(Effect.provide(AppTest)),
    )

    expect(decision).toEqual({})
  })

  test("aggregation detects conflicting write-worker outputs", async () => {
    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* WorkerRuns
        const aggregation = yield* WorkerAggregation
        yield* runs.createQueued({
          worker_id: "worker-1",
          session_id: "session-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt_hash: "prompt-hash-1",
          scope: "src/allowed/**",
        })
        yield* runs.complete("worker-1", workerResult("first"))
        yield* runs.createQueued({
          worker_id: "worker-2",
          session_id: "session-1",
          agent_type: "test-engineer",
          mode: "write-allowed",
          prompt_hash: "prompt-hash-2",
          scope: "src/allowed/**",
        })
        yield* runs.complete("worker-2", workerResult("second"))
        return yield* aggregation.summarizeSession("session-1")
      }).pipe(Effect.provide(AppTest)),
    )

    expect(summary.completed).toBe(2)
    expect(summary.conflicts).toEqual([
      {
        path: "src/allowed/file.ts",
        worker_ids: ["worker-1", "worker-2"],
      },
    ])
    expect(summary.ready_for_integration).toBe(false)
  })

  test("aggregation blocks write-worker outputs without passed verification", async () => {
    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* WorkerRuns
        const aggregation = yield* WorkerAggregation
        yield* runs.createQueued({
          worker_id: "worker-unverified",
          session_id: "session-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt_hash: "prompt-hash-unverified",
          scope: "src/allowed/**",
        })
        yield* runs.complete("worker-unverified", {
          ...workerResult("unverified"),
          verification: [
            {
              check: "worker integration",
              status: "not_run",
              evidence: "not run",
            },
          ],
        })
        return yield* aggregation.summarizeSession("session-1")
      }).pipe(Effect.provide(AppTest)),
    )

    expect(summary.ready_for_integration).toBe(false)
    expect(summary.blockers.join("\n")).toContain("verification not passed")
  })

  test("TaskCompleted blocks while parent workers are still unresolved", async () => {
    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* WorkerRuns
        yield* runs.createQueued({
          worker_id: "worker-pending",
          session_id: "session-1",
          parent_task_id: "parent-task-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt_hash: "prompt-hash-pending",
          scope: "src/allowed/**",
        })
        return yield* handleTaskCompleted(taskCompletedPayload("parent-task-1"))
      }).pipe(Effect.provide(AppTest)),
    )

    expect("decision" in decision).toBe(true)
    if ("decision" in decision) {
      expect(decision.decision).toBe("block")
      expect(decision.reason).toContain("worker runs are still unresolved")
    }
  })

  test("TaskCompleted blocks completed worker patches that have not been integrated", async () => {
    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* WorkerRuns
        yield* runs.createQueued({
          worker_id: "worker-patch",
          session_id: "session-1",
          parent_task_id: "parent-task-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt_hash: "prompt-hash-patch",
          scope: "src/allowed/**",
        })
        yield* runs.complete("worker-patch", workerResult("patch"), undefined, {
          isolation: "worktree",
          patch_path: "/tmp/worker-patch.patch",
        })
        return yield* handleTaskCompleted(taskCompletedPayload("parent-task-1"))
      }).pipe(Effect.provide(AppTest)),
    )

    expect("decision" in decision).toBe(true)
    if ("decision" in decision) {
      expect(decision.decision).toBe("block")
      expect(decision.reason).toContain("pending integration")
    }
  })

  test("TaskCompleted blocks integrated worker changes until parent verification is recorded", async () => {
    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* WorkerRuns
        yield* runs.createQueued({
          worker_id: "worker-complete",
          session_id: "session-1",
          parent_task_id: "parent-task-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt_hash: "prompt-hash-complete",
          scope: "src/allowed/**",
        })
        yield* runs.complete("worker-complete", workerResult("complete"), undefined, {
          isolation: "worktree",
          patch_path: "/tmp/worker-complete.patch",
        })
        yield* runs.markIntegrated("worker-complete")
        return yield* handleTaskCompleted(taskCompletedPayload("parent-task-1"))
      }).pipe(Effect.provide(AppTest)),
    )

    expect("decision" in decision).toBe(true)
    if ("decision" in decision) {
      expect(decision.decision).toBe("block")
      expect(decision.reason).toContain("final verification")
    }
  })

  test("TaskCompleted blocks write-worker changes that were never isolated", async () => {
    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* WorkerRuns
        const state = yield* SessionState
        yield* runs.createQueued({
          worker_id: "worker-unisolated",
          session_id: "session-1",
          parent_task_id: "parent-task-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt_hash: "prompt-hash-unisolated",
          scope: "src/allowed/**",
        })
        yield* runs.complete("worker-unisolated", workerResult("unisolated"))
        yield* state.update("session-1", { verification_status: "passed" })
        return yield* handleTaskCompleted(taskCompletedPayload("parent-task-1"))
      }).pipe(Effect.provide(AppTest)),
    )

    expect("decision" in decision).toBe(true)
    if ("decision" in decision) {
      expect(decision.decision).toBe("block")
      expect(decision.reason).toContain("captured isolated patch")
    }
  })

  test("TaskCompleted passes once parent workers are completed and parent verification is recorded", async () => {
    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* WorkerRuns
        const state = yield* SessionState
        yield* runs.createQueued({
          worker_id: "worker-complete",
          session_id: "session-1",
          parent_task_id: "parent-task-1",
          agent_type: "executor",
          mode: "write-allowed",
          prompt_hash: "prompt-hash-complete",
          scope: "src/allowed/**",
        })
        yield* runs.complete("worker-complete", workerResult("complete"), undefined, {
          isolation: "worktree",
          patch_path: "/tmp/worker-complete.patch",
        })
        yield* runs.markIntegrated("worker-complete")
        yield* state.update("session-1", { verification_status: "passed" })
        return yield* handleTaskCompleted(taskCompletedPayload("parent-task-1"))
      }).pipe(Effect.provide(AppTest)),
    )

    expect(decision).toEqual({})
  })
})
