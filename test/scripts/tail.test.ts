import { describe, expect, test } from "bun:test"
import * as fsP from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

const SCRIPT = path.resolve(import.meta.dir, "..", "..", "scripts", "tail.ts")

const writeLine = async (file: string, obj: unknown): Promise<void> => {
  await fsP.appendFile(file, JSON.stringify(obj) + "\n", "utf8")
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")

describe("scripts/tail.ts", () => {
  test("emits 3 existing lines plus 1 newly appended line", async () => {
    const tmp = await fsP.mkdtemp(path.join(os.tmpdir(), "tail-"))
    const dir = path.join(tmp, ".claude-hooks", "state", "sess-A")
    await fsP.mkdir(dir, { recursive: true })
    const ledger = path.join(dir, "ledger.jsonl")
    const now = Date.now()
    await writeLine(ledger, { timestamp: now, event: "alpha", sessionId: "sess-A", summary: "first" })
    await writeLine(ledger, { timestamp: now + 10, event: "beta", sessionId: "sess-A", summary: "second" })
    await writeLine(ledger, { timestamp: now + 20, event: "gamma", sessionId: "sess-A", summary: "third" })

    const proc = Bun.spawn({
      cmd: ["bun", "run", SCRIPT, "--cwd", tmp],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    })

    // Allow initial-read + 200ms grace
    await new Promise((r) => setTimeout(r, 1200))
    // Append a 4th line; allow another 500ms (poll 200ms + read)
    await writeLine(ledger, { timestamp: now + 30, event: "delta", sessionId: "sess-A", summary: "fourth" })
    await new Promise((r) => setTimeout(r, 800))

    proc.kill("SIGINT")
    const stdout = stripAnsi(await new Response(proc.stdout).text())
    try { await proc.exited } catch { /* ignore */ }

    expect(stdout).toContain("first")
    expect(stdout).toContain("second")
    expect(stdout).toContain("third")
    expect(stdout).toContain("fourth")

    await fsP.rm(tmp, { recursive: true, force: true })
  }, 15_000)

  test("--session filter only emits matching session_id", async () => {
    const tmp = await fsP.mkdtemp(path.join(os.tmpdir(), "tail-"))
    const dirX = path.join(tmp, ".claude-hooks", "state", "sess-X")
    const dirY = path.join(tmp, ".claude-hooks", "state", "sess-Y")
    await fsP.mkdir(dirX, { recursive: true })
    await fsP.mkdir(dirY, { recursive: true })
    const now = Date.now()
    await writeLine(path.join(dirX, "ledger.jsonl"), {
      timestamp: now,
      event: "match",
      sessionId: "sess-X",
      summary: "keep-me",
    })
    // Simulate a Y entry written into the X ledger to verify filter behavior:
    await writeLine(path.join(dirX, "ledger.jsonl"), {
      timestamp: now + 1,
      event: "skip",
      sessionId: "sess-Y",
      summary: "drop-me",
    })

    const proc = Bun.spawn({
      cmd: ["bun", "run", SCRIPT, "--cwd", tmp, "--session", "sess-X"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    })
    await new Promise((r) => setTimeout(r, 1500))
    proc.kill("SIGINT")
    const stdout = stripAnsi(await new Response(proc.stdout).text())
    try { await proc.exited } catch { /* ignore */ }

    expect(stdout).toContain("keep-me")
    expect(stdout).not.toContain("drop-me")

    await fsP.rm(tmp, { recursive: true, force: true })
  }, 15_000)

  test("initial read samples a bounded suffix without emitting old huge lines", async () => {
    const tmp = await fsP.mkdtemp(path.join(os.tmpdir(), "tail-"))
    const dir = path.join(tmp, ".claude-hooks", "state", "sess-large")
    await fsP.mkdir(dir, { recursive: true })
    const ledger = path.join(dir, "ledger.jsonl")
    const now = Date.now()
    await writeLine(ledger, {
      timestamp: now,
      event: "old",
      sessionId: "sess-large",
      summary: `TOP_SECRET_OLD_${"x".repeat(2 * 1024 * 1024)}`,
    })
    await writeLine(ledger, {
      timestamp: now + 1,
      event: "new",
      sessionId: "sess-large",
      summary: "visible tail",
    })

    const proc = Bun.spawn({
      cmd: ["bun", "run", SCRIPT, "--cwd", tmp, "--session", "sess-large"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    })
    await new Promise((r) => setTimeout(r, 1500))
    proc.kill("SIGINT")
    const stdout = stripAnsi(await new Response(proc.stdout).text())
    try { await proc.exited } catch { /* ignore */ }

    expect(stdout).toContain("visible tail")
    expect(stdout).not.toContain("TOP_SECRET_OLD")

    await fsP.rm(tmp, { recursive: true, force: true })
  }, 15_000)
})
