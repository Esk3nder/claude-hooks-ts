import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeReplay, resolveWorkspace, resolvePin, minimalEnv, argvEqual, evalReplayArgvSafety } from "../replay.ts"
import { confine, isValidId, isValidRunId } from "../fsx.ts"
import { loadBrief } from "../briefs.ts"
import { writeBaseline, isUserPinned } from "../trust.ts"
import { sessionSecret, roleStats, appendLedger } from "../runs.ts"
import { gitProject, registerBrief } from "./helpers.ts"
import { spawnSync } from "node:child_process"

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "chs-")))

describe("replay security (§13)", () => {
  const cwd = tmp()
  const opts = { timeoutMs: 5000, maxBytes: 1200, envAllow: [] as string[] }
  test("argv-only: shell metachars are literal", async () => {
    const r = await executeReplay({ argv: ["echo", "$(whoami); rm -rf /"], cwd: ".", risk: "low" }, cwd, opts)
    expect(r.exitCode).toBe(0)
    expect(r.tail).toContain("$(whoami)")
  })
  test("env replace: secret absent unless allowlisted", async () => {
    process.env["CHF_SECRET"] = "leak"
    try {
      const closed = await executeReplay({ argv: ["env"], cwd: ".", risk: "low" }, cwd, opts)
      expect(closed.tail).not.toContain("leak")
      const open = await executeReplay({ argv: ["env"], cwd: ".", risk: "low" }, cwd, { ...opts, envAllow: ["CHF_SECRET"] })
      expect(open.tail).toContain("leak")
    } finally { delete process.env["CHF_SECRET"] }
  })
  test("minimalEnv exposes only the base four + allowlist", () => {
    expect(Object.keys(minimalEnv([])).every((k) => ["PATH", "HOME", "LANG", "TMPDIR"].includes(k))).toBe(true)
  })
  test("timeout kills the process group fast", async () => {
    const t0 = Date.now()
    const r = await executeReplay({ argv: ["sh", "-c", "sleep 30 & wait"], cwd: ".", risk: "low" }, cwd, { ...opts, timeoutMs: 250 })
    expect(r.timedOut).toBe(true)
    expect(Date.now() - t0).toBeLessThan(3000)
  })
  test("workspace escape rejected", () => {
    const root = tmp(); mkdirSync(join(root, "sub"))
    expect(resolveWorkspace(root, "sub").ok).toBe(true)
    expect(resolveWorkspace(root, "..").ok).toBe(false)
  })
  test("resolvePin: worker cannot choose its own command", () => {
    expect(resolvePin(["rm", "-rf", "/"], null, [{ argv: ["bun", "test"], cwd_policy: "workspace", idempotent: true, max_output_bytes: 1, risk: "low" }])).toBeNull()
    expect(resolvePin(["bun", "test"], null, [{ argv: ["bun", "test"], cwd_policy: "workspace", idempotent: true, max_output_bytes: 1, risk: "low" }])).not.toBeNull()
  })
})

describe("replay argv safety (§6.3, F5)", () => {
  test("destructive / interpreter-inline argv refused; build commands allowed", () => {
    expect(evalReplayArgvSafety(["git", "push", "--force", "origin", "main"]).ok).toBe(false)
    expect(evalReplayArgvSafety(["rm", "-rf", "/etc"]).ok).toBe(false)
    expect(evalReplayArgvSafety(["python", "-c", "import os"]).ok).toBe(false)
    expect(evalReplayArgvSafety(["bash", "-c", "echo hi"]).ok).toBe(false)
    expect(evalReplayArgvSafety(["tee", ".env"]).ok).toBe(false)
    expect(evalReplayArgvSafety(["bun", "test"]).ok).toBe(true)
    expect(evalReplayArgvSafety(["python", "-m", "pytest"]).ok).toBe(true)
    expect(evalReplayArgvSafety(["pytest"]).ok).toBe(true)
  })
  test("N6: env-wrapped and versioned interpreters with inline code → refused", () => {
    expect(evalReplayArgvSafety(["env", "python3", "-c", "import os"]).ok).toBe(false)
    expect(evalReplayArgvSafety(["env", "FOO=1", "python3", "-c", "x"]).ok).toBe(false)
    expect(evalReplayArgvSafety(["python3.12", "-c", "x"]).ok).toBe(false)
    expect(evalReplayArgvSafety(["/usr/bin/python3.11", "-c", "x"]).ok).toBe(false)
    expect(evalReplayArgvSafety(["env", "bun", "test"]).ok).toBe(true)
  })
})

describe("session secret (§6.5, F7)", () => {
  test("256-bit hex, unique per project, stable across calls", () => {
    const a = gitProject(); const b = gitProject()
    const sa = sessionSecret(a)
    expect(sa).toMatch(/^[0-9a-f]{64}$/)
    expect(sa).not.toBe(sessionSecret(b))
    expect(sessionSecret(a)).toBe(sa) // persisted, not regenerated
  })
})

describe("sampling stats integrity (§8, F8)", () => {
  test("roleStats counts only replayed rows scoped to this project", async () => {
    const a = gitProject() // sets CLAUDE_HOOKS_LOG_DIR → a/.claude-hooks
    await appendLedger(a, "worker-acceptance", { role: "implementer", outcome: "accepted_verified", replayed: true })
    await appendLedger(a, "worker-acceptance", { role: "implementer", outcome: "rejected", replayed: true })
    await appendLedger(a, "worker-acceptance", { role: "implementer", outcome: "accepted_verified", replayed: false }) // no-replay farm attempt
    await appendLedger("/other/repo", "worker-acceptance", { role: "implementer", outcome: "accepted_verified", replayed: true }) // cross-project
    const st = roleStats(a, "implementer")
    expect(st.runs).toBe(2) // only the two genuine replay rows in THIS project
    expect(st.accepted).toBe(1) // one of them passed
  })
})

describe("path confinement & ids (§2)", () => {
  test("confine rejects escapes", () => {
    const root = tmp()
    expect(confine(root, "a/b.json")).not.toBeNull()
    expect(confine(root, "../escape")).toBeNull()
    expect(confine(root, "a/../../x")).toBeNull()
  })
  test("id + run_id charset", () => {
    expect(isValidId("impl-a_1")).toBe(true)
    expect(isValidId("../x")).toBe(false)
    expect(isValidRunId("root/impl-a/impl-a1")).toBe(true)
    expect(isValidRunId("root/../x")).toBe(false)
  })
  test("brief symlink rejected (O_NOFOLLOW)", () => {
    const p = gitProject()
    mkdirSync(join(p, ".claude-hooks", "briefs"), { recursive: true })
    writeFileSync(join(p, "secret.json"), JSON.stringify({ schema_version: 1, role: "implementer", label: "evil" }))
    symlinkSync(join(p, "secret.json"), join(p, ".claude-hooks", "briefs", "evil.json"))
    const lk = loadBrief(p, "evil")
    expect(lk.brief).toBeNull()
    expect(lk.reason).toContain("symlink")
  })
  test("brief label with separators rejected", () => {
    const p = gitProject()
    expect(loadBrief(p, "../../etc/passwd").brief).toBeNull()
  })
})

describe("trust baseline (§2.1, fix #1)", () => {
  test("committed-clean file is user-pinned; mid-session edit is not", () => {
    const p = gitProject()
    writeFileSync(join(p, "probes.ts"), "export const probes = {}\n")
    spawnSync("git", ["add", "-A"], { cwd: p })
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "probe"], { cwd: p })
    writeBaseline(p, "sess-1", ["probes.ts"])
    expect(isUserPinned(p, "probes.ts")).toBe(true)
    // model edits it mid-session
    writeFileSync(join(p, "probes.ts"), "export const probes = { evil: () => true }\n")
    expect(isUserPinned(p, "probes.ts")).toBe(false)
  })
  test("file created mid-session (not in baseline) is not user-pinned", () => {
    const p = gitProject()
    writeBaseline(p, "sess-1", ["probes.ts"]) // probes.ts absent at start
    writeFileSync(join(p, "probes.ts"), "x\n")
    spawnSync("git", ["add", "-A"], { cwd: p })
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "late"], { cwd: p })
    expect(isUserPinned(p, "probes.ts")).toBe(false) // not in the start snapshot
  })
})
