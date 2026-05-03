import { describe, expect, test } from "bun:test"

const DISPATCHER = new URL("../src/dispatcher.ts", import.meta.url).pathname

const runDispatcher = async (
  action: string,
  stdin: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const proc = Bun.spawn(["bun", "run", DISPATCHER, action], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  proc.stdin.write(stdin)
  await proc.stdin.end()
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ])
  const exitCode = await proc.exited
  return { stdout, stderr, exitCode }
}

describe("dispatcher subprocess", () => {
  test("malformed stdin → exit 0 + valid JSON safe default", async () => {
    const r = await runDispatcher("PreToolUse", "not json {{{")
    expect(r.exitCode).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(typeof parsed).toBe("object")
  }, 30_000)

  test("missing action → exit 0 + valid JSON", async () => {
    const proc = Bun.spawn(["bun", "run", DISPATCHER], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.stdin.end()
    const stdout = await new Response(proc.stdout as ReadableStream).text()
    const exitCode = await proc.exited
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed).toEqual({})
  }, 30_000)

  test("valid PreToolUse payload → exit 0 + JSON decision", async () => {
    const payload = JSON.stringify({
      _tag: "PreToolUse",
      session_id: "s",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    })
    const r = await runDispatcher("PreToolUse", payload)
    expect(r.exitCode).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(typeof parsed).toBe("object")
  }, 30_000)
})
