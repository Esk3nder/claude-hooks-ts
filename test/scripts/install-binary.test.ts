import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { runInstall } from "../../scripts/install.ts"

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

class StringSink {
  buf = ""
  write(chunk: string | Uint8Array): boolean {
    this.buf +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    return true
  }
}
const sinkAsStream = (s: StringSink) => s as unknown as NodeJS.WritableStream

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..")
const archMap: Record<string, string> = { x64: "x64", arm64: "arm64" }
const arch = archMap[process.arch] ?? process.arch
const platform =
  process.platform === "linux"
    ? "linux"
    : process.platform === "darwin"
      ? "darwin"
      : process.platform
const BIN = path.join(REPO_ROOT, "dist", `claude-hook-${platform}-${arch}`)

let tmpDir: string
let target: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chts-install-binary-"))
  target = path.join(tmpDir, "settings.json")
})
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
})

describe("install: compiled-binary path", () => {
  test("default dry-run does not lazy-build the compiled binary", async () => {
    if (fs.existsSync(BIN)) fs.rmSync(BIN, { force: true })
    const out = new StringSink()
    const code = await runInstall(
      ["--dry-run", "--target", target, "--install-root", REPO_ROOT],
      sinkAsStream(out),
    )
    expect(code).toBe(0)
    expect(stripAnsi(out.buf)).not.toContain("compiling claude-hook")
    expect(fs.existsSync(BIN)).toBe(false)
  })

  test("default --apply lazy-builds and points settings at the compiled binary", async () => {
    if (fs.existsSync(BIN)) fs.rmSync(BIN, { force: true })
    const out = new StringSink()
    const code = await runInstall(
      ["--apply", "--target", target, "--install-root", REPO_ROOT],
      sinkAsStream(out),
    )
    expect(code).toBe(0)
    // Lazy-build was triggered
    expect(stripAnsi(out.buf)).toContain("compiling claude-hook")
    // Binary now exists
    expect(fs.existsSync(BIN)).toBe(true)
    // Settings.json points at the binary, not the bash shim
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    const cmd = parsed.hooks["PreToolUse"]?.[0]?.hooks?.[0]?.command ?? ""
    expect(cmd).toContain(`dist/claude-hook-${platform}-${arch}`)
    expect(cmd).not.toContain("bin/claude-hook")
  })

  test("--no-binary forces the bash shim (escape hatch)", async () => {
    const out = new StringSink()
    const code = await runInstall(
      [
        "--apply",
        "--no-binary",
        "--target",
        target,
        "--install-root",
        REPO_ROOT,
      ],
      sinkAsStream(out),
    )
    expect(code).toBe(0)
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    const cmd = parsed.hooks["PreToolUse"]?.[0]?.hooks?.[0]?.command ?? ""
    expect(cmd).toContain("bin/claude-hook")
    expect(cmd).not.toContain("dist/")
  })

  test("compiled binary runs end-to-end without bun on PATH", () => {
    if (!fs.existsSync(BIN)) {
      // This test depends on the lazy-build test having run first, or on the
      // binary existing from prior CI/build. Skip silently otherwise.
      return
    }
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
    const r = spawnSync(BIN, ["PreToolUse"], {
      input: JSON.stringify({
        session_id: "binary-test",
        hook_event_name: "PreToolUse",
        cwd: REPO_ROOT,
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
      env: {
        // Sanitized PATH — Claude Code's hook subprocess env. Compiled binary
        // bundles bun runtime, so this works even though `bun` is not findable.
        PATH: "/usr/bin:/bin",
        HOME: os.homedir(),
      },
      encoding: "utf8",
    })
    expect(r.status).toBe(0)
    expect(() => JSON.parse(r.stdout)).not.toThrow()
  })
})
