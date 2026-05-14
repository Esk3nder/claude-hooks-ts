import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Stream } from "effect"
import { EventStoreError } from "../../src/schema/errors.ts"
import { inferWorkerScope } from "../../src/events/subagent-scope-gate.ts"
import { evaluateWorkerToolPermission, pathInWorkerScope } from "../../src/policies/worker-permissions.ts"
import type { WorkerRun } from "../../src/schema/worker-run.ts"
import { RuntimeConfigTest } from "../../src/services/runtime-config.ts"
import { WorkerRuns } from "../../src/services/worker-runs.ts"

const stateUnavailable = new EventStoreError({
  op: "tail",
  stream: "worker-runs",
  path: "/missing/runs.jsonl",
  message: "state unavailable",
})

const failingWorkerRuns = Layer.succeed(
  WorkerRuns,
  WorkerRuns.of({
    createQueued: () => Effect.die("unused"),
    markRunning: () => Effect.die("unused"),
    markBlocked: () => Effect.die("unused"),
    complete: () => Effect.die("unused"),
    markIntegrated: () => Effect.die("unused"),
    fail: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
    get: () => Effect.fail(stateUnavailable),
    findByAgent: () => Effect.fail(stateUnavailable),
    forSession: () => Effect.fail(stateUnavailable),
    forParent: () => Effect.fail(stateUnavailable),
    list: () => Effect.fail(stateUnavailable),
    stream: () => Stream.fail(stateUnavailable),
  }),
)

const workerRun = (overrides: Partial<WorkerRun> = {}): WorkerRun => ({
  worker_id: "session-1:worker-1",
  session_id: "session-1",
  agent_id: "worker-1",
  agent_type: "executor",
  mode: "write-allowed",
  status: "running",
  prompt_hash: "prompt-hash",
  scope: "src/**",
  created_at: "2026-05-13T00:00:00.000Z",
  attempts: 1,
  ...overrides,
})

const workerRunsWith = (runs: ReadonlyArray<WorkerRun>) =>
  Layer.succeed(
    WorkerRuns,
    WorkerRuns.of({
      createQueued: () => Effect.die("unused"),
      markRunning: () => Effect.die("unused"),
      markBlocked: () => Effect.die("unused"),
      complete: () => Effect.die("unused"),
      markIntegrated: () => Effect.die("unused"),
      fail: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
      get: (workerId) => Effect.succeed(runs.find((run) => run.worker_id === workerId) ?? null),
      findByAgent: (sessionId, agentId) =>
        Effect.succeed(runs.find((run) => run.session_id === sessionId && run.agent_id === agentId) ?? null),
      forSession: (sessionId) => Effect.succeed(runs.filter((run) => run.session_id === sessionId)),
      forParent: (parentTaskId) => Effect.succeed(runs.filter((run) => run.parent_task_id === parentTaskId)),
      list: () => Effect.succeed(runs),
      stream: () => Stream.fromIterable(runs),
    }),
  )

describe("worker permission policy", () => {
  test("bare directory scopes are treated as scoped directories", () => {
    expect(pathInWorkerScope("src", "/repo", "/repo/src/file.ts")).toBe(true)
    expect(pathInWorkerScope("src", "/repo", "/repo/docs/file.ts")).toBe(false)
  })

  test("empty or prose-only scopes do not allow every path", () => {
    expect(pathInWorkerScope("scope: only", "/repo", "/repo/src/file.ts")).toBe(false)
  })

  test("worker scope inference ignores role-contract prose and defaults closed", () => {
    expect(inferWorkerScope(undefined)).toBe("")
    expect(
      inferWorkerScope("Scope: You are a read-only investigator. Return evidence only."),
    ).toBe("")
    expect(inferWorkerScope("Scope: src\nEdit only source files.")).toBe("src")
    expect(inferWorkerScope("Assigned scope: src/services/**")).toBe("src/services/**")
  })

  test("worker state lookup failures deny write-capable tools fail-closed", async () => {
    const decision = await Effect.runPromise(
      evaluateWorkerToolPermission({
        _tag: "PreToolUse",
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        worker_id: "worker-1",
        tool_name: "Write",
        tool_input: {
          file_path: "src/file.ts",
          content: "content",
        },
        cwd: "/repo",
      }).pipe(
        Effect.provide(Layer.mergeAll(RuntimeConfigTest(), failingWorkerRuns)),
      ),
    )

    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") expect(decision.reason).toContain("fail-closed")
  })

  test("worker state lookup failures deny non-allowlisted Bash fail-closed", async () => {
    const decision = await Effect.runPromise(
      evaluateWorkerToolPermission({
        _tag: "PreToolUse",
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        worker_id: "worker-1",
        tool_name: "Bash",
        tool_input: {
          command: "node -e \"require('fs').rmSync('src/file.ts')\"",
        },
        cwd: "/repo",
      }).pipe(
        Effect.provide(Layer.mergeAll(RuntimeConfigTest(), failingWorkerRuns)),
      ),
    )

    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") expect(decision.reason).toContain("fail-closed")
  })

  test("unknown explicit worker ids deny write tools fail-closed", async () => {
    const decision = await Effect.runPromise(
      evaluateWorkerToolPermission({
        _tag: "PreToolUse",
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        worker_id: "missing-worker",
        tool_name: "Write",
        tool_input: {
          file_path: "src/file.ts",
          content: "content",
        },
        cwd: "/repo",
      }).pipe(
        Effect.provide(Layer.mergeAll(RuntimeConfigTest(), workerRunsWith([]))),
      ),
    )

    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") expect(decision.reason).toContain("fail-closed")
  })

  test("bare subagent tool payloads pass through when no WorkerRun exists", async () => {
    const decision = await Effect.runPromise(
      evaluateWorkerToolPermission({
        _tag: "PreToolUse",
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        agent_id: "bare-agent",
        tool_name: "Bash",
        tool_input: {
          command: "grep -R TODO src",
        },
        cwd: "/repo",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RuntimeConfigTest(),
            workerRunsWith([workerRun({ worker_id: "session-1:worker-active" })]),
          ),
        ),
      ),
    )

    expect(decision.kind).toBe("passthrough")
  })

  test("package worker CLI bypasses active-worker correlation lockout", async () => {
    const commands = [
      "./bin/claude-hooks-workers list --json",
      "./bin/claude-hooks-workers cancel session-1:worker-1 --reason killed",
      "bun run scripts/workers.ts list --json",
    ]

    for (const command of commands) {
      const decision = await Effect.runPromise(
        evaluateWorkerToolPermission({
          _tag: "PreToolUse",
          hook_event_name: "PreToolUse",
          session_id: "session-1",
          tool_name: "Bash",
          tool_input: { command },
          cwd: "/repo",
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              RuntimeConfigTest(),
              workerRunsWith([workerRun({ worker_id: "session-1:worker-active" })]),
            ),
          ),
        ),
      )

      expect(decision.kind).toBe("passthrough")
    }
  })

  test("worker id from runtime config correlates spawned worker tool use", async () => {
    const decision = await Effect.runPromise(
      evaluateWorkerToolPermission({
        _tag: "PreToolUse",
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        tool_name: "Write",
        tool_input: {
          file_path: "src/file.ts",
          content: "content",
        },
        cwd: "/repo",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RuntimeConfigTest({ workerIdOverride: Option.some("worker-1") }),
            workerRunsWith([workerRun()]),
          ),
        ),
      ),
    )

    expect(decision.kind).toBe("passthrough")
  })

  test("read-only workers cannot hide mutations in allowlisted command names", async () => {
    const decision = await Effect.runPromise(
      evaluateWorkerToolPermission({
        _tag: "PreToolUse",
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        worker_id: "worker-1",
        tool_name: "Bash",
        tool_input: {
          command: "find src -delete",
        },
        cwd: "/repo",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RuntimeConfigTest(),
            workerRunsWith([workerRun({ agent_type: "Explore", mode: "read-only" })]),
          ),
        ),
      ),
    )

    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") expect(decision.reason).toContain("read-only")
  })

  test("read-only worker read tools are constrained to assigned scope", async () => {
    const decision = await Effect.runPromise(
      evaluateWorkerToolPermission({
        _tag: "PreToolUse",
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        worker_id: "worker-1",
        tool_name: "Read",
        tool_input: {
          file_path: "docs/out-of-scope.md",
        },
        cwd: "/repo",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RuntimeConfigTest(),
            workerRunsWith([workerRun({ agent_type: "Explore", mode: "read-only" })]),
          ),
        ),
      ),
    )

    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") expect(decision.reason).toContain("cannot read outside assigned scope")
  })

  test("read-only worker Bash cannot use file-content readers to bypass Read policy", async () => {
    const decision = await Effect.runPromise(
      evaluateWorkerToolPermission({
        _tag: "PreToolUse",
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        worker_id: "worker-1",
        tool_name: "Bash",
        tool_input: {
          command: "cat docs/out-of-scope.md",
        },
        cwd: "/repo",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RuntimeConfigTest(),
            workerRunsWith([workerRun({ agent_type: "Explore", mode: "read-only" })]),
          ),
        ),
      ),
    )

    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") expect(decision.reason).toContain("read-only")
  })

  test("contracted read-only workers remain constrained to allowlisted Bash", async () => {
    const decision = await Effect.runPromise(
      evaluateWorkerToolPermission({
        _tag: "PreToolUse",
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        worker_id: "worker-1",
        tool_name: "Bash",
        tool_input: {
          command: "grep -R TODO src",
        },
        cwd: "/repo",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RuntimeConfigTest(),
            workerRunsWith([workerRun({ agent_type: "Explore", mode: "read-only" })]),
          ),
        ),
      ),
    )

    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") expect(decision.reason).toContain("read-only")
  })

  test("read-only worker cannot run whole-repo git inspection for a scoped run", async () => {
    const decision = await Effect.runPromise(
      evaluateWorkerToolPermission({
        _tag: "PreToolUse",
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        worker_id: "worker-1",
        tool_name: "Bash",
        tool_input: {
          command: "git ls-files",
        },
        cwd: "/repo",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RuntimeConfigTest(),
            workerRunsWith([workerRun({ agent_type: "Explore", mode: "read-only", scope: "src/**" })]),
          ),
        ),
      ),
    )

    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") expect(decision.reason).toContain("whole-repo")
  })

  test("read-only worker may run scoped git inspection with an in-scope pathspec", async () => {
    const decision = await Effect.runPromise(
      evaluateWorkerToolPermission({
        _tag: "PreToolUse",
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        worker_id: "worker-1",
        tool_name: "Bash",
        tool_input: {
          command: "git ls-files -- src",
        },
        cwd: "/repo",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RuntimeConfigTest(),
            workerRunsWith([workerRun({ agent_type: "Explore", mode: "read-only", scope: "src/**" })]),
          ),
        ),
      ),
    )

    expect(decision.kind).toBe("passthrough")
  })

  test("read-only worker cannot mutate branches through Bash", async () => {
    const decision = await Effect.runPromise(
      evaluateWorkerToolPermission({
        _tag: "PreToolUse",
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        worker_id: "worker-1",
        tool_name: "Bash",
        tool_input: {
          command: "git branch scratch",
        },
        cwd: "/repo",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RuntimeConfigTest(),
            workerRunsWith([workerRun({ agent_type: "Explore", mode: "read-only", scope: "src/**" })]),
          ),
        ),
      ),
    )

    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") expect(decision.reason).toContain("branch mutation")
  })

  test("write workers cannot use unrecognized shell writes because scope cannot be enforced", async () => {
    const decision = await Effect.runPromise(
      evaluateWorkerToolPermission({
        _tag: "PreToolUse",
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        worker_id: "worker-1",
        tool_name: "Bash",
        tool_input: {
          command: "python3 -c \"open('src/file.ts','w').write('x')\"",
        },
        cwd: "/repo",
      }).pipe(
        Effect.provide(Layer.mergeAll(RuntimeConfigTest(), workerRunsWith([workerRun()]))),
      ),
    )

    expect(decision.kind).toBe("ask")
    if (decision.kind === "ask") expect(decision.reason).toContain("scope cannot be enforced")
  })

  test("empty read-only scope does not deny ordinary read tools", async () => {
    const decision = await Effect.runPromise(
      evaluateWorkerToolPermission({
        _tag: "PreToolUse",
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        worker_id: "worker-1",
        tool_name: "Read",
        tool_input: {
          file_path: "docs/readme.md",
        },
        cwd: "/repo",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RuntimeConfigTest(),
            workerRunsWith([workerRun({ agent_type: "Explore", mode: "read-only", scope: "" })]),
          ),
        ),
      ),
    )

    expect(decision.kind).toBe("passthrough")
  })

  test("empty write scope asks before write-capable tools", async () => {
    const decision = await Effect.runPromise(
      evaluateWorkerToolPermission({
        _tag: "PreToolUse",
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        worker_id: "worker-1",
        tool_name: "Write",
        tool_input: {
          file_path: "src/file.ts",
          content: "content",
        },
        cwd: "/repo",
      }).pipe(
        Effect.provide(Layer.mergeAll(RuntimeConfigTest(), workerRunsWith([workerRun({ scope: "" })]))),
      ),
    )

    expect(decision.kind).toBe("ask")
    if (decision.kind === "ask") expect(decision.reason).toContain("no assigned write scope")
  })

  test("terminal worker ids fail closed for write-capable tools", async () => {
    const decision = await Effect.runPromise(
      evaluateWorkerToolPermission({
        _tag: "PreToolUse",
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        worker_id: "worker-1",
        tool_name: "Write",
        tool_input: {
          file_path: "src/file.ts",
          content: "content",
        },
        cwd: "/repo",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(RuntimeConfigTest(), workerRunsWith([workerRun({ status: "completed" })])),
        ),
      ),
    )

    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") expect(decision.reason).toContain("fail-closed")
  })

  test("Glob combines path and pattern before scope enforcement", async () => {
    const decision = await Effect.runPromise(
      evaluateWorkerToolPermission({
        _tag: "PreToolUse",
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        worker_id: "worker-1",
        tool_name: "Glob",
        tool_input: {
          pattern: "*.ts",
          path: "src",
        },
        cwd: "/repo",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RuntimeConfigTest(),
            workerRunsWith([workerRun({ agent_type: "Explore", mode: "read-only", scope: "src/**" })]),
          ),
        ),
      ),
    )

    expect(decision.kind).toBe("passthrough")
  })

  test("pathless Glob is allowed when the effective cwd is inside assigned scope", async () => {
    const decision = await Effect.runPromise(
      evaluateWorkerToolPermission({
        _tag: "PreToolUse",
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        worker_id: "worker-1",
        tool_name: "Glob",
        tool_input: {
          pattern: "*.ts",
        },
        cwd: "/repo/src",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RuntimeConfigTest(),
            workerRunsWith([workerRun({ agent_type: "Explore", mode: "read-only", scope: "src/**" })]),
          ),
        ),
      ),
    )

    expect(decision.kind).toBe("passthrough")
  })

  test("Grep path plus traversal glob cannot escape assigned scope", async () => {
    const decision = await Effect.runPromise(
      evaluateWorkerToolPermission({
        _tag: "PreToolUse",
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        worker_id: "worker-1",
        tool_name: "Grep",
        tool_input: {
          pattern: "TODO",
          path: "src",
          glob: "../docs/**",
        },
        cwd: "/repo",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RuntimeConfigTest(),
            workerRunsWith([workerRun({ agent_type: "Explore", mode: "read-only", scope: "src/**" })]),
          ),
        ),
      ),
    )

    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") expect(decision.reason).toContain("outside assigned scope")
  })
})
