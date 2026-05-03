import { describe, expect, test } from "bun:test"

const DISPATCHER = new URL("../src/dispatcher.ts", import.meta.url).pathname

const runDispatcher = async (
  action: string,
  stdin: string,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number; ms: number }> => {
  const start = Date.now()
  const proc = Bun.spawn(["bun", "run", DISPATCHER, action], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })
  proc.stdin.write(stdin)
  await proc.stdin.end()
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ])
  const exitCode = await proc.exited
  return { stdout, stderr, exitCode, ms: Date.now() - start }
}

describe("dispatcher Effect.timeout (Item #1)", () => {
  test("hung handler is capped at ~4s and emits safe default", async () => {
    const payload = JSON.stringify({
      _tag: "PreToolUse",
      session_id: "s",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    })
    const r = await runDispatcher("PreToolUse", payload, {
      CLAUDE_HOOKS_TEST_HANG_EVENT: "PreToolUse",
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("{}")
    // Should have cut off near the 4s mark, well before the 5s sleep finishes.
    expect(r.ms).toBeLessThan(4_500 + 2_000) // 2s buffer for bun startup
  }, 30_000)
})
