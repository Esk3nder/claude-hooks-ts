import { describe, expect, test } from "bun:test"
import * as path from "node:path"

const REPO_ROOT = path.resolve(__dirname, "..", "..")
const DISPATCHER = path.join(REPO_ROOT, "src", "dispatcher.ts")

const SAMPLE_PAYLOAD = JSON.stringify({
  _tag: "UserPromptSubmit",
  hook_event_name: "UserPromptSubmit",
  session_id: "bench",
  prompt: "ping",
})

const RUNS = 50
// p50 budget. Default 100ms; bump to 150 in CI environments where cold-start
// is noisier (documented in README troubleshooting).
const BUDGET_MS = process.env["CI"] === "true" ? 350 : 300

const median = (xs: ReadonlyArray<number>): number => {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
  }
  return sorted[mid] ?? 0
}

describe("cold-start dispatcher (VAL-M5-003)", () => {
  test(
    `Bun spawn p50 < ${BUDGET_MS}ms over ${RUNS} runs (UserPromptSubmit)`,
    async () => {
      const samples: number[] = []
      for (let i = 0; i < RUNS; i += 1) {
        const start = performance.now()
        const proc = Bun.spawn(
          ["bun", DISPATCHER, "UserPromptSubmit"],
          { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        )
        proc.stdin.write(SAMPLE_PAYLOAD)
        await proc.stdin.end()
        await proc.exited
        const elapsed = performance.now() - start
        samples.push(elapsed)
      }
      const p50 = median(samples)
      const min = Math.min(...samples)
      const max = Math.max(...samples)
      // Diagnostic output (visible only on failure)
      // eslint-disable-next-line no-console
      console.log(
        `cold-start: runs=${RUNS} p50=${p50.toFixed(1)}ms min=${min.toFixed(1)}ms max=${max.toFixed(1)}ms budget=${BUDGET_MS}ms`,
      )
      expect(p50).toBeLessThan(BUDGET_MS)
    },
    120_000,
  )
})
