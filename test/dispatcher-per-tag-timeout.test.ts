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

describe("dispatcher per-tag timeout (B1)", () => {
  test("UserPromptSubmit gets the raised 15s cap (hung handler does not trip 4s default)", async () => {
    // The hang sleeps cap+1000ms, so for UserPromptSubmit (15s cap) it sleeps 16s.
    // We don't want the test to actually wait 15s, so we instead assert the
    // handler is still running past the 5s mark without having returned. We
    // give the dispatcher 6s of wall time and then kill the process — if the
    // 4s cap had fired (regression), it would have emitted SAFE_DEFAULT well
    // before our 6s deadline.
    const payload = JSON.stringify({
      _tag: "UserPromptSubmit",
      session_id: "s",
      hook_event_name: "UserPromptSubmit",
      prompt: "any",
    })
    const start = Date.now()
    const proc = Bun.spawn(["bun", "run", DISPATCHER, "UserPromptSubmit"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_HOOKS_TEST_HANG_EVENT: "UserPromptSubmit" },
    })
    proc.stdin.write(payload)
    await proc.stdin.end()
    // Give it 6s to maybe return early, then force-kill.
    const finished = await Promise.race([
      proc.exited.then((code) => ({ code, killed: false })),
      new Promise<{ code: number | null; killed: true }>((resolve) =>
        setTimeout(() => {
          try {
            proc.kill("SIGKILL")
          } catch {
            // ignore
          }
          resolve({ code: null, killed: true })
        }, 6_000),
      ),
    ])
    const elapsed = Date.now() - start
    expect(finished.killed).toBe(true)
    // Sanity: it really was running past 5s before we killed it — proves the
    // 4s default cap did NOT fire on this tag.
    expect(elapsed).toBeGreaterThanOrEqual(5_500)
  }, 30_000)

  test("PreToolUse still respects the 4s default cap", async () => {
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
    // Same envelope as the legacy test: 4s cap + bun startup buffer.
    expect(r.ms).toBeLessThan(4_500 + 2_000)
  }, 30_000)
})
