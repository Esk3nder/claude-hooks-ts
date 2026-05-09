import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..")
const SHIM = path.join(REPO_ROOT, "bin", "claude-hook")

const findBun = (): string | null => {
  for (const c of [
    process.env["BUN_INSTALL"]
      ? path.join(process.env["BUN_INSTALL"], "bin", "bun")
      : null,
    path.join(os.homedir(), ".bun", "bin", "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
    process.execPath,
  ]) {
    if (c && fs.existsSync(c)) {
      try {
        fs.accessSync(c, fs.constants.X_OK)
        return c
      } catch {
        /* not executable */
      }
    }
  }
  return null
}

const BUN = findBun()

describe("bin/claude-hook shim", () => {
  test("works under sanitized PATH (no bun on PATH) — regression for hook-fire failure", () => {
    if (!BUN) return
    // Send a real Claude Code-shape payload (no _tag) so we exercise both
    // the shim (PATH resolution) and the schema (wire format). On main this
    // setup printed `bun: not found`; the fixed shim resolves bun via $BUN
    // even when PATH has no bun.
    const r = spawnSync(SHIM, ["PreToolUse"], {
      input: JSON.stringify({
        session_id: "shim-test",
        hook_event_name: "PreToolUse",
        cwd: REPO_ROOT,
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
      env: {
        // Sanitized PATH simulating Claude Code's hook subprocess env.
        PATH: "/usr/bin:/bin",
        HOME: os.homedir(),
        BUN, // explicit absolute path, what the shim would use as fallback
      },
      encoding: "utf8",
    })
    expect(r.status).toBe(0)
    // SAFE_DEFAULT or a valid decision; either way it's parseable JSON.
    expect(() => JSON.parse(r.stdout)).not.toThrow()
  })

  test("works when invoked through a symlink — regression for $(dirname \"$0\") bug", () => {
    if (!BUN) return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shim-symlink-"))
    const link = path.join(dir, "claude-hook")
    fs.symlinkSync(SHIM, link)
    const r = spawnSync(link, ["PreToolUse"], {
      input: JSON.stringify({
        session_id: "shim-symlink-test",
        hook_event_name: "PreToolUse",
        cwd: REPO_ROOT,
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
      env: { PATH: "/usr/bin:/bin", HOME: os.homedir(), BUN },
      encoding: "utf8",
    })
    fs.rmSync(dir, { recursive: true, force: true })
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain("Module not found")
    expect(r.stderr).not.toContain("not found")
  })

  test("emits actionable error when bun cannot be located", () => {
    const r = spawnSync(SHIM, ["PreToolUse"], {
      input: "{}",
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
      encoding: "utf8",
    })
    // exit 1 with a usable error pointing to the install command
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("bun not found")
    expect(r.stderr).toContain("https://bun.sh/install")
  })
})
