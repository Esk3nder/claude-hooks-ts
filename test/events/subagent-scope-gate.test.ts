import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  handleSubagentStart,
  handleSubagentStop,
} from "../../src/events/subagent-scope-gate.ts"
import {
  NormalizedHookEvent,
  type NormalizedSubagentStart,
} from "../../src/schema/normalized.ts"
import { SessionStateTest } from "../../src/services/session-state.ts"
import { EventStoreLive } from "../../src/services/event-store.ts"
import { RuntimeConfigTest } from "../../src/services/runtime-config.ts"
import { WorkerRuns, WorkerRunsLive, scopedWorkerRunId } from "../../src/services/worker-runs.ts"
import { appendWorkerContract } from "../../src/policies/worker-contract.ts"
import { CommandRunnerTest, type CommandRunResult } from "../../src/services/command-runner.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(NormalizedHookEvent)(raw)
const decodeStart = (raw: unknown): NormalizedSubagentStart =>
  decode(raw) as NormalizedSubagentStart

const startPayload = (agent_type: string) =>
  decodeStart({
    _tag: "SubagentStart",
    session_id: "s",
    hook_event_name: "SubagentStart",
    agent_type,
    agent_id: "a1",
    prompt: appendWorkerContract("do the thing", agent_type),
  })

const bareStartPayload = (agent_type: string) =>
  decodeStart({
    _tag: "SubagentStart",
    session_id: "s",
    hook_event_name: "SubagentStart",
    agent_type,
    agent_id: "a1",
    prompt: "do the thing",
  })

const stopPayload = (agent_type: string, output: string | undefined) =>
  decode({
    _tag: "SubagentStop",
    session_id: "s",
    hook_event_name: "SubagentStop",
    agent_type,
    agent_id: "a1",
    ...(output === undefined ? {} : { output }),
  })

const runContractedStop = (agent_type: string, output: string | undefined) =>
  Effect.gen(function* () {
    yield* handleSubagentStart(startPayload(agent_type))
    return yield* handleSubagentStop(stopPayload(agent_type, output))
  }).pipe(Effect.provide(SessionStateTest()))

describe("VAL-M4-003 subagent-scope-gate", () => {
  test("bare subagent start is left untouched", async () => {
    const d = await Effect.runPromise(
      handleSubagentStart(bareStartPayload("Explore")).pipe(
        Effect.provide(SessionStateTest()),
      ),
    )
    expect(d).toEqual({})
  })

  test("Explore start injects read-only scope rule", async () => {
    const d = await Effect.runPromise(
      handleSubagentStart(startPayload("Explore")).pipe(
        Effect.provide(SessionStateTest()),
      ),
    )
    expect("hookSpecificOutput" in d).toBe(true)
    if ("hookSpecificOutput" in d) {
      const out = d.hookSpecificOutput as { additionalContext: string }
      expect(out.additionalContext).toContain("read-only investigator")
      expect(out.additionalContext).toContain("Explore")
      expect(out.additionalContext).toContain("Output contract")
    }
  })

  test("general-purpose start injects write-allowed rule", async () => {
    const d = await Effect.runPromise(
      handleSubagentStart(startPayload("general-purpose")).pipe(
        Effect.provide(SessionStateTest()),
      ),
    )
    if ("hookSpecificOutput" in d) {
      const out = d.hookSpecificOutput as { additionalContext: string }
      expect(out.additionalContext).toContain("modify files")
    }
  })

  test("investigative subagent stop without evidence → block", async () => {
    const d = await Effect.runPromise(runContractedStop("Explore", "ok done"))
    expect("decision" in d).toBe(true)
    if ("decision" in d) {
      expect(d.decision).toBe("block")
      expect(d.reason).toContain("evidence")
    }
  })

  test("investigative subagent stop with evidence → no-op", async () => {
    const d = await Effect.runPromise(
      runContractedStop(
        "Explore",
        "found bug at src/foo.ts:42 — confidence: high",
      ),
    )
    expect(d).toEqual({})
  })

  test("non-investigative subagent stop never blocks", async () => {
    const d = await Effect.runPromise(runContractedStop("general-purpose", "done"))
    expect(d).toEqual({})
  })

  test("native write worker with reported changes stays blocked without captured patch", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-subagent-scope-"))
    try {
      const output = JSON.stringify({
        summary: "changed files",
        files_relevant: [],
        changes_made: [
          {
            path: "src/services/worker-integration.ts",
            summary: "edited worker integration",
          },
        ],
        commands_run: [],
        verification: [
          {
            check: "manual",
            status: "passed",
            evidence: "reported by worker",
          },
        ],
        risks: [],
        blockers: [],
        confidence: "high",
      })
      const workerId = scopedWorkerRunId("s", "a1")
      const layer = Layer.mergeAll(
        SessionStateTest(),
        Layer.provide(WorkerRunsLive(root), EventStoreLive),
        RuntimeConfigTest(),
      )

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const runs = yield* WorkerRuns
          yield* runs.createQueued({
            worker_id: workerId,
            session_id: "s",
            agent_id: "a1",
            agent_type: "general-purpose",
            mode: "write-allowed",
            prompt_hash: "prompt-hash",
            scope: "src/**",
          })
          yield* runs.markRunning(workerId)
          const decision = yield* handleSubagentStop(stopPayload("general-purpose", output))
          return {
            decision,
            latest: yield* runs.get(workerId),
          }
        }).pipe(Effect.provide(layer)),
      )

      expect("decision" in result.decision).toBe(true)
      if ("decision" in result.decision) {
        expect(result.decision.decision).toBe("block")
        expect(result.decision.reason).toContain("captured isolated patch")
      }
      expect(result.latest?.status).toBe("blocked")
      expect(result.latest?.isolation).toBeUndefined()
      expect(result.latest?.patch_path).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("missing output without worker ledger → block for investigative role", async () => {
    const d = await Effect.runPromise(runContractedStop("Explore", undefined))
    if ("decision" in d) {
      expect(d.decision).toBe("block")
    }
  })

  test("bare investigative subagent stop is left untouched", async () => {
    const d = await Effect.runPromise(
      handleSubagentStop(stopPayload("Explore", "Halting.")).pipe(
        Effect.provide(SessionStateTest()),
      ),
    )
    expect(d).toEqual({})
  })

  test("legacy subagent_type / result fields still work (backward compat)", async () => {
    const d = await Effect.runPromise(
      handleSubagentStop(
        decode({
          _tag: "SubagentStop",
          session_id: "s-legacy",
          hook_event_name: "SubagentStop",
          subagent_type: "Explore",
          task_id: "t-legacy",
          result: "found bug at src/foo.ts:42 — confidence: high",
        }),
      ).pipe(Effect.provide(SessionStateTest())),
    )
    expect(d).toEqual({})
  })

  test("investigative subagent stop still blocks after a prior missing-evidence block", async () => {
    const payload = stopPayload("Explore", "ok done")
    const program = Effect.gen(function* () {
      yield* handleSubagentStart(startPayload("Explore"))
      const first = yield* handleSubagentStop(payload)
      const second = yield* handleSubagentStop(payload)
      return { first, second }
    }).pipe(Effect.provide(SessionStateTest()))

    const r = await Effect.runPromise(program)
    expect("decision" in r.first).toBe(true)
    expect("decision" in r.second).toBe(true)
    if ("decision" in r.second) {
      expect(r.second.decision).toBe("block")
      expect(r.second.reason).toContain("Output contract")
    }
  })

  test("planner stop with judgment-only output (no file:line) passes", async () => {
    const d = await Effect.runPromise(
      runContractedStop(
        "planner",
        "Recommendation: split auth module. Risk: session migration. Next steps: draft RFC.",
      ),
    )
    expect(d).toEqual({})
  })

  test("planner stop with empty output still blocks", async () => {
    const d = await Effect.runPromise(runContractedStop("architect", "ok"))
    expect("decision" in d).toBe(true)
    if ("decision" in d) expect(d.decision).toBe("block")
  })

  // P0-2: read-only worker silent mutation detection. Pre-fix, a
  // read-only worker that mutated a parent-cwd tracked file while
  // reporting `changes_made: []` completed cleanly — only the
  // self-report flagged it, and a worker could simply omit. After
  // the fix, `recordWorkerStart` snapshots the parent cwd's tracked
  // tree via `git stash create` (recorded as `baseline_ref` on the
  // run), and `recordWorkerStop` re-snapshots + diffs. Any drift not
  // also in `changes_made` blocks the SubagentStop.
  test("read-only worker mutating tracked files outside changes_made → block (P0-2)", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-p0-2-drift-"))
    const beforeStash = "1111111111111111111111111111111111111111"
    const afterStash = "2222222222222222222222222222222222222222"
    let stashCalls = 0
    try {
      const cmdRunnerLayer = CommandRunnerTest((command, args) => {
        const baseResult = (stdout = ""): CommandRunResult => ({
          stdout,
          stderr: "",
          exitCode: 0,
          timedOut: false,
          durationMs: 0,
          commandPreview: [command, ...args].join(" "),
        })
        if (command !== "git") return baseResult()
        if (args.join(" ") === "stash create") {
          stashCalls += 1
          return baseResult(stashCalls === 1 ? `${beforeStash}\n` : `${afterStash}\n`)
        }
        if (args[0] === "diff" && args.includes("--name-only")) {
          // The parent cwd's tracked tree diverged: a file the worker
          // didn't declare in `changes_made`.
          return baseResult("src/secret.ts\n")
        }
        return { ...baseResult(), exitCode: 1, stderr: `unexpected git ${args.join(" ")}` }
      })
      const output = JSON.stringify({
        summary: "explored the codebase",
        files_relevant: [{ path: "src/secret.ts", reason: "looked at it" }],
        // Worker reports no changes — but the snapshots will reveal
        // src/secret.ts was modified.
        changes_made: [],
        commands_run: [],
        verification: [],
        risks: [],
        blockers: [],
        confidence: "high",
      })
      const layer = Layer.mergeAll(
        SessionStateTest(),
        Layer.provide(WorkerRunsLive(root), EventStoreLive),
        RuntimeConfigTest(),
        cmdRunnerLayer,
      )
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          // Start triggers recordWorkerStart → captures baseline_ref.
          yield* handleSubagentStart(startPayload("Explore"))
          // Stop triggers drift detection.
          const decision = yield* handleSubagentStop(
            decode({
              _tag: "SubagentStop",
              session_id: "s",
              hook_event_name: "SubagentStop",
              agent_type: "Explore",
              agent_id: "a1",
              cwd: root,
              output,
            }),
          )
          const runs = yield* WorkerRuns
          return {
            decision,
            latest: yield* runs.get(scopedWorkerRunId("s", "a1")),
          }
        }).pipe(Effect.provide(layer)),
      )

      expect("decision" in result.decision).toBe(true)
      if ("decision" in result.decision) {
        expect(result.decision.decision).toBe("block")
        expect(result.decision.reason).toContain(
          "read-only worker mutated tracked files outside changes_made",
        )
        expect(result.decision.reason).toContain("src/secret.ts")
      }
      expect(result.latest?.status).toBe("blocked")
      // baseline_ref captured at start — sanity check.
      expect(result.latest?.baseline_ref).toBe(beforeStash)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // P0-2 negative: same setup but the worker DECLARES the change in
  // `changes_made`. Drift exists, but it's accounted for, so the
  // stop is not blocked by the new check. (It's still subject to the
  // pre-existing "read-only worker reported changes_made" guard,
  // which fires unconditionally when changes_made is non-empty.
  // That's the older defense — proving here that the new check
  // doesn't ADD a block when declarations match.)
  test("read-only worker that declares its mutation hits the pre-existing changes_made guard, not the new drift check", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-p0-2-declared-"))
    let stashCalls = 0
    try {
      const cmdRunnerLayer = CommandRunnerTest((command, args) => {
        const baseResult = (stdout = ""): CommandRunResult => ({
          stdout,
          stderr: "",
          exitCode: 0,
          timedOut: false,
          durationMs: 0,
          commandPreview: [command, ...args].join(" "),
        })
        if (command !== "git") return baseResult()
        if (args.join(" ") === "stash create") {
          stashCalls += 1
          return baseResult(stashCalls === 1 ? "1111\n" : "2222\n")
        }
        return baseResult()
      })
      const output = JSON.stringify({
        summary: "edited a file (declared)",
        files_relevant: [],
        changes_made: [
          { path: "src/declared.ts", summary: "an edit" },
        ],
        commands_run: [],
        verification: [],
        risks: [],
        blockers: [],
        confidence: "high",
      })
      const layer = Layer.mergeAll(
        SessionStateTest(),
        Layer.provide(WorkerRunsLive(root), EventStoreLive),
        RuntimeConfigTest(),
        cmdRunnerLayer,
      )
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* handleSubagentStart(startPayload("Explore"))
          return yield* handleSubagentStop(
            decode({
              _tag: "SubagentStop",
              session_id: "s",
              hook_event_name: "SubagentStop",
              agent_type: "Explore",
              agent_id: "a1",
              cwd: root,
              output,
            }),
          )
        }).pipe(Effect.provide(layer)),
      )
      // Blocked by the OLDER guard (`changes_made.length > 0` for
      // read-only is forbidden), not by the new drift check.
      expect("decision" in result).toBe(true)
      if ("decision" in result) {
        expect(result.decision).toBe("block")
        expect(result.reason).toContain(
          "read-only worker reported changes_made",
        )
        // Not the new check.
        expect(result.reason).not.toContain("outside changes_made")
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("M11 invocation key — agent_id is canonical", () => {
  test("agent_id is used verbatim as the identity", async () => {
    const p = decodeStart({
      _tag: "SubagentStart",
      session_id: "s1",
      hook_event_name: "SubagentStart",
      agent_type: "Explore",
      agent_id: "agent-42",
      cwd: "/repo",
    })
    const { invocationKey } = await import(
      "../../src/events/subagent-scope-gate.ts"
    )
    const k = invocationKey(p)
    expect(k).toBe("s1:Explore:agent-42")
  })

  test("legacy task_id is honoured when agent_id is absent", async () => {
    const p = decodeStart({
      _tag: "SubagentStart",
      session_id: "s1",
      hook_event_name: "SubagentStart",
      subagent_type: "Explore",
      task_id: "task-42",
      cwd: "/repo",
    })
    const { invocationKey } = await import(
      "../../src/events/subagent-scope-gate.ts"
    )
    const k = invocationKey(p)
    expect(k).toBe("s1:Explore:task-42")
  })

  test("two parallel SubagentStarts without agent_id/task_id produce distinct keys", async () => {
    const p1 = decodeStart({
      _tag: "SubagentStart",
      session_id: "s1",
      hook_event_name: "SubagentStart",
      agent_type: "Explore",
      cwd: "/repo/a",
    })
    const p2 = decodeStart({
      _tag: "SubagentStart",
      session_id: "s1",
      hook_event_name: "SubagentStart",
      agent_type: "Explore",
      cwd: "/repo/b",
    })
    const { invocationKey } = await import(
      "../../src/events/subagent-scope-gate.ts"
    )
    const k1 = invocationKey(p1)
    const k2 = invocationKey(p2)
    expect(k1).not.toBe(k2)
    expect(k1.startsWith("s1:Explore:")).toBe(true)
    expect(k2.startsWith("s1:Explore:")).toBe(true)
  })

  test("identical payloads collapse to the same key (idempotent)", async () => {
    const make = () =>
      decodeStart({
        _tag: "SubagentStart",
        session_id: "s1",
        hook_event_name: "SubagentStart",
        agent_type: "Explore",
        cwd: "/repo",
      })
    const { invocationKey } = await import(
      "../../src/events/subagent-scope-gate.ts"
    )
    const a = invocationKey(make())
    const b = invocationKey(make())
    expect(a).toBe(b)
  })
})
