import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  type ApprovalRecord,
  GC_INTERVAL_MS,
} from "../../src/services/approvals.ts"

const DAY = 24 * 60 * 60 * 1000

const mkRec = (
  cwd: string,
  pattern: string,
  recordedAt: number,
  status: "approved" | "denied" | "pending" = "approved",
): ApprovalRecord => ({ cwd, pattern, status, recordedAt })

describe("dispatcher wires Approvals.gc", () => {
  test("running dispatcher with stale last_gc prunes old approvals", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-gc-"))
    const stateDir = path.join(tmp, ".claude-hooks", "state")
    await fs.mkdir(stateDir, { recursive: true })

    // Seed an old + a fresh approval, both for `tmp` cwd.
    const now = Date.now()
    const old = mkRec(tmp, "Bash(stale)", now - 30 * DAY)
    const fresh = mkRec(tmp, "Bash(fresh)", now - 60 * 1000)
    const ledger = path.join(stateDir, "approvals.jsonl")
    await fs.writeFile(
      ledger,
      [old, fresh].map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    )

    // Force gc to run by writing an old last_gc timestamp.
    const meta = path.join(stateDir, "approvals-meta.json")
    await fs.writeFile(
      meta,
      JSON.stringify({ last_gc: now - GC_INTERVAL_MS - 60 * 1000 }) + "\n",
      "utf8",
    )

    // Build a benign payload that includes the temp cwd.
    const payload = {
      _tag: "SessionStart",
      session_id: "sid-int-1",
      hook_event_name: "SessionStart",
      cwd: tmp,
    }
    const dispatcher = path.resolve(
      __dirname,
      "..",
      "..",
      "src",
      "dispatcher.ts",
    )
    const r = spawnSync(
      "bun",
      [dispatcher, "SessionStart"],
      {
        input: JSON.stringify(payload),
        cwd: tmp,
        encoding: "utf8",
        timeout: 15_000,
      },
    )
    expect(r.status).toBe(0)

    // Ledger should now have only the fresh entry.
    expect(fsSync.existsSync(ledger)).toBe(true)
    const after = await fs.readFile(ledger, "utf8")
    expect(after).toContain("Bash(fresh)")
    expect(after).not.toContain("Bash(stale)")

    // Meta updated to a recent timestamp.
    const m = JSON.parse(await fs.readFile(meta, "utf8")) as {
      last_gc: number
    }
    expect(m.last_gc).toBeGreaterThan(now - 60 * 1000)

    await fs.rm(tmp, { recursive: true, force: true })
  }, 20_000)
})
