import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventStoreLive } from "../../src/services/event-store.ts"
import { WorkerRuns, WorkerRunsLive } from "../../src/services/worker-runs.ts"
import { runWorkersDetailed } from "../../scripts/workers.ts"
import type { WorkerResult } from "../../src/schema/worker-run.ts"

const validResult = (): WorkerResult => ({
  summary: "worker done",
  files_relevant: [],
  changes_made: [],
  commands_run: [],
  verification: [
    {
      check: "workers cli",
      status: "passed",
      evidence: "seeded typed result",
    },
  ],
  risks: [],
  blockers: [],
  confidence: "high",
})

const capture = () => {
  let stdout = ""
  let stderr = ""
  return {
    out: {
      stdout: (message: string) => {
        stdout += message
      },
      stderr: (message: string) => {
        stderr += message
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

const seed = (root: string) =>
  Effect.gen(function* () {
    const runs = yield* WorkerRuns
    yield* runs.createQueued({
      worker_id: "worker-1",
      session_id: "session-1",
      parent_task_id: "parent-1",
      agent_type: "executor",
      mode: "write-allowed",
      prompt_hash: "prompt-hash-1",
      scope: "src/**",
    })
    yield* runs.complete("worker-1", validResult())
    yield* runs.createQueued({
      worker_id: "worker-2",
      session_id: "session-1",
      parent_task_id: "parent-1",
      agent_type: "Explore",
      mode: "read-only",
      prompt_hash: "prompt-hash-2",
      scope: "src/**",
    })
  }).pipe(Effect.provide(WorkerRunsLive(root)), Effect.provide(EventStoreLive))

describe("scripts/workers.ts", () => {
  test("list, show, and summary expose bounded worker state", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-workers-cli-"))
    try {
      await Effect.runPromise(seed(root))

      const listOut = capture()
      expect(await runWorkersDetailed(["list", "--cwd", root, "--session", "session-1", "--json"], listOut.out)).toBe(0)
      const listed = JSON.parse(listOut.stdout()) as ReadonlyArray<{ worker_id: string }>
      expect(listed.map((run) => run.worker_id)).toEqual(["worker-1", "worker-2"])

      const showOut = capture()
      expect(await runWorkersDetailed(["show", "worker-1", "--cwd", root], showOut.out)).toBe(0)
      expect(showOut.stdout()).toContain("worker-1 completed executor")
      expect(showOut.stdout()).toContain("summary=worker done")

      const summaryOut = capture()
      expect(await runWorkersDetailed(["summary", "--cwd", root, "--session", "session-1", "--json"], summaryOut.out)).toBe(0)
      const summary = JSON.parse(summaryOut.stdout()) as {
        readonly workers_total: number
        readonly active_worker_ids: ReadonlyArray<string>
        readonly ready_for_integration: boolean
      }
      expect(summary.workers_total).toBe(2)
      expect(summary.active_worker_ids).toEqual(["worker-2"])
      expect(summary.ready_for_integration).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("cancel marks a worker run cancelled", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-workers-cli-"))
    try {
      await Effect.runPromise(seed(root))
      const output = capture()
      expect(await runWorkersDetailed(["cancel", "worker-2", "--cwd", root, "--reason", "operator stopped it"], output.out)).toBe(0)
      expect(output.stdout()).toContain("worker-2 cancelled")
      expect(output.stdout()).toContain("operator stopped it")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("retry requeues with a new prompt hash without persisting the raw prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-workers-cli-"))
    try {
      await Effect.runPromise(seed(root))
      const prompt = "SECRET RAW PROMPT SHOULD NOT PERSIST"
      const output = capture()
      expect(await runWorkersDetailed(["retry", "worker-2", "--cwd", root, "--prompt", prompt], output.out)).toBe(0)
      expect(output.stdout()).toContain("worker-2-retry-")
      expect(output.stdout()).toContain("queued")

      const persisted = readFileSync(join(root, ".claude-hooks", "state", "workers", "default.jsonl"), "utf8")
      expect(persisted).toContain("worker-2-retry-")
      expect(persisted).toContain(`"cwd":"${root}"`)
      expect(persisted).toContain("redacted")
      expect(persisted).not.toContain(prompt)

      const runsFile = readFileSync(join(root, ".claude-hooks", "state", "workers", "runs.jsonl"), "utf8")
      expect(runsFile).toContain("worker-2-retry-")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("retry honors durable queue capacity before persisting a new job", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-workers-cli-full-"))
    const originalCapacity = process.env["CLAUDE_HOOKS_WORKER_QUEUE_CAPACITY"]
    process.env["CLAUDE_HOOKS_WORKER_QUEUE_CAPACITY"] = "1"
    try {
      await Effect.runPromise(seed(root))
      const prompt = "SECOND RAW PROMPT SHOULD NOT PERSIST"
      const output = capture()
      expect(await runWorkersDetailed(["retry", "worker-1", "--cwd", root, "--prompt", prompt], output.out)).toBe(1)
      expect(output.stderr()).toContain("worker queue capacity reached")

      const latest = await Effect.runPromise(
        Effect.gen(function* () {
          const runs = yield* WorkerRuns
          return yield* runs.get("worker-1")
        }).pipe(Effect.provide(WorkerRunsLive(root)), Effect.provide(EventStoreLive)),
      )
      expect(latest?.status).toBe("completed")
      const queueFile = join(root, ".claude-hooks", "state", "workers", "default.jsonl")
      expect(() => readFileSync(queueFile, "utf8")).toThrow()
    } finally {
      if (originalCapacity === undefined) {
        delete process.env["CLAUDE_HOOKS_WORKER_QUEUE_CAPACITY"]
      } else {
        process.env["CLAUDE_HOOKS_WORKER_QUEUE_CAPACITY"] = originalCapacity
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
})
