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
// p50 budget. Local: 300ms. CI: 600ms.
//
// CI runner drift: the post-#46 main build (run 26001100790, 2026-05-17)
// already failed at p50≈496ms with min≈479ms — every single sample over the
// old 450ms ceiling. Lazy-loading inspection-whitelist trimmed ~20ms but the
// floor is still set by GitHub-runner cold spawn. Raising the CI ceiling to
// 600ms gives headroom for typical variance while staying tight enough to
// catch genuine 2x regressions. Re-tighten if/when runner perf recovers.
// Bun cold start alone is ~120ms; remainder is dispatcher import + Effect
// runtime + Match dispatch + AppLive composition.
const BUDGET_MS = process.env["CI"] === "true" ? 600 : 300

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
          {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            // Bypass live classifier — this benchmark measures dispatcher
            // cold-start (Bun + import + Effect + Match), not the classifier
            // subprocess (which has its own latency telemetry).
            env: { ...process.env, CLAUDE_HOOKS_DISABLE_CLASSIFIER: "1" },
          },
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
