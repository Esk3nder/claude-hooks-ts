import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const DISPATCHER = new URL("../src/dispatcher.ts", import.meta.url).pathname

const runDispatcher = async (
  action: string,
  stdin: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const proc = Bun.spawn(["bun", "run", DISPATCHER, action], {
    cwd,
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

describe("dispatcher ledger append", () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ch-ledger-"))
  })

  afterEach(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })

  test("dispatched decision lands at .claude-hooks/state/<sessionId>/ledger.jsonl", async () => {
    const sessionId = "ses-abc"
    const payload = JSON.stringify({
      _tag: "PreToolUse",
      session_id: sessionId,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      cwd: tmp,
    })
    const r = await runDispatcher("PreToolUse", payload, tmp)
    expect(r.exitCode).toBe(0)

    const ledger = path.join(
      tmp,
      ".claude-hooks",
      "state",
      sessionId,
      "ledger.jsonl",
    )
    expect(fs.existsSync(ledger)).toBe(true)
    const lines = fs
      .readFileSync(ledger, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
    expect(lines.length).toBe(1)
    const entry = JSON.parse(lines[0]!)
    expect(entry.event).toBe("PreToolUse")
    expect(entry.sessionId).toBe(sessionId)
    expect(typeof entry.timestamp).toBe("number")
    expect(entry.data).toBeDefined()
  }, 30_000)

  test("two events for the same session append to one file", async () => {
    const sessionId = "ses-multi"
    const mk = (tag: string): string =>
      JSON.stringify({
        _tag: tag,
        session_id: sessionId,
        hook_event_name: tag,
        tool_name: "Bash",
        tool_input: { command: "ls" },
        cwd: tmp,
      })
    const r1 = await runDispatcher("PreToolUse", mk("PreToolUse"), tmp)
    expect(r1.exitCode).toBe(0)
    const r2 = await runDispatcher("PreToolUse", mk("PreToolUse"), tmp)
    expect(r2.exitCode).toBe(0)

    const ledger = path.join(
      tmp,
      ".claude-hooks",
      "state",
      sessionId,
      "ledger.jsonl",
    )
    const lines = fs
      .readFileSync(ledger, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
    expect(lines.length).toBe(2)
  }, 60_000)

  test("different sessions write to different files", async () => {
    const mk = (sid: string): string =>
      JSON.stringify({
        _tag: "PreToolUse",
        session_id: sid,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        cwd: tmp,
      })
    await runDispatcher("PreToolUse", mk("sid-A"), tmp)
    await runDispatcher("PreToolUse", mk("sid-B"), tmp)
    const a = path.join(tmp, ".claude-hooks", "state", "sid-A", "ledger.jsonl")
    const b = path.join(tmp, ".claude-hooks", "state", "sid-B", "ledger.jsonl")
    expect(fs.existsSync(a)).toBe(true)
    expect(fs.existsSync(b)).toBe(true)
  }, 60_000)
})
