import { describe, expect, test } from "bun:test"
import { writeFileSync, mkdirSync, readFileSync, existsSync, mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { handleSubagentStart, handleSubagentStop, handlePreToolUse, handleStop } from "../dispatch.ts"
import { loadVerdict, verifyVerdict, type Verdict } from "../runs.ts"
import { loadEvidence } from "../evidence.ts"
import { gitProject, writePolicy, registerBrief, startSession, implResult } from "./helpers.ts"
import type { WorkerBrief } from "../types.ts"

const SESS = "sess-e2e"
const PIN = ["true"] // exits 0
const FAILPIN = ["false"] // exits 1
const allow = (argv: string[], risk: "low" | "high" = "low") => ({ replay: { allowed_argv: [{ argv, cwd_policy: "workspace" as const, idempotent: true, max_output_bytes: 1024, risk }], timeout_ms: 5000, env_allow: [] } })

function setup(briefExtra: Partial<WorkerBrief> = {}, pin = PIN): string {
  const p = gitProject()
  writeFileSync(join(p, "src.ts"), "ok\n")
  writePolicy(p, allow(pin)) // committed below → the allowlist is user-pinned (committed-clean at session start)
  spawnSync("git", ["add", "-A"], { cwd: p }); spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"], { cwd: p })
  startSession(p, SESS)
  return p
}

async function runOnce(p: string, label: string, role: "implementer" | "scout" | "skeptic", msg: string, registerFirst = true, brief?: WorkerBrief) {
  const b: WorkerBrief = brief ?? { schema_version: 1, role, label, acceptance: { argv: PIN, cwd: ".", replay: "required", idempotent: true } }
  if (registerFirst) registerBrief(p, b)
  const start = handleSubagentStart({ project: p, session_id: SESS, run_id: label, agent_id: label, parent_run_id: null, agent_type: role, label })
  expect(start.ok).toBe(true)
  if (!registerFirst) registerBrief(p, b) // forged: appears after start
  return handleSubagentStop({ project: p, session_id: SESS, run_id: label, event_seq: 1, last_assistant_message: msg })
}

describe("seam e2e (§3,§4,§6.2)", () => {
  test("registered brief + allowlist-pinned replay match → accepted_verified + ISC flip + evidence", async () => {
    const p = setup()
    const brief: WorkerBrief = { schema_version: 1, role: "implementer", label: "spine-a", isa_path: ".claude-hooks/ISA.md", isc_id: "ISC1", files_in_scope: ["src.ts"], acceptance: { argv: PIN, cwd: ".", replay: "required", idempotent: true } }
    const r = await runOnce(p, "spine-a", "implementer", implResult("spine-a", p, PIN), true, brief)
    expect(r.outcome).toBe("accepted_verified")
    const ev = loadEvidence(p, SESS, "ISC1")
    expect(ev?.status).toBe("valid")
    expect(ev?.trust_label).toBe("verified")
    expect(Object.keys(ev!.depends_on.file_scope)).toContain("src.ts")
  })

  test("F2: model-authored (uncommitted) allowlist does NOT mint a verified flip", async () => {
    // policy.json is written AFTER session start and never committed ⇒ not user-pinned.
    const p = gitProject()
    writeFileSync(join(p, "src.ts"), "ok\n")
    spawnSync("git", ["add", "-A"], { cwd: p }); spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"], { cwd: p })
    startSession(p, SESS)
    writePolicy(p, allow(PIN)) // the model writes its own allowlist mid-session
    const brief: WorkerBrief = { schema_version: 1, role: "implementer", label: "evil-spine", isa_path: ".claude-hooks/ISA.md", isc_id: "ISC1", files_in_scope: ["src.ts"], acceptance: { argv: PIN, cwd: ".", replay: "required", idempotent: true } }
    registerBrief(p, brief)
    handleSubagentStart({ project: p, session_id: SESS, run_id: "evil-spine", agent_id: "evil-spine", parent_run_id: null, agent_type: "implementer", label: "evil-spine" })
    const r = await handleSubagentStop({ project: p, session_id: SESS, run_id: "evil-spine", event_seq: 1, last_assistant_message: implResult("evil-spine", p, PIN) })
    expect(r.outcome).toBe("accepted_verified") // replay matched...
    expect(loadEvidence(p, SESS, "ISC1")).toBeNull() // ...but no spine flip from an untrusted allowlist
  })

  test("forged brief (registered after start) → soft_failed", async () => {
    const p = setup()
    const r = await runOnce(p, "forge-a", "implementer", implResult("forge-a", p, PIN), false)
    expect(r.outcome).toBe("soft_failed")
  })

  test("replay contradiction → block ×2 → rejected", async () => {
    const p = setup(undefined, FAILPIN)
    const brief: WorkerBrief = { schema_version: 1, role: "implementer", label: "bad-a", acceptance: { argv: FAILPIN, cwd: ".", replay: "required", idempotent: true } }
    registerBrief(p, brief)
    handleSubagentStart({ project: p, session_id: SESS, run_id: "bad-a", agent_id: "bad-a", parent_run_id: null, agent_type: "implementer", label: "bad-a" })
    const msg = implResult("bad-a", p, FAILPIN) // claims exit 0, `false` exits 1
    const r1 = await handleSubagentStop({ project: p, session_id: SESS, run_id: "bad-a", event_seq: 1, last_assistant_message: msg })
    expect(r1.decision).toBe("block")
    const r2 = await handleSubagentStop({ project: p, session_id: SESS, run_id: "bad-a", event_seq: 2, last_assistant_message: msg })
    expect(r2.decision).toBe("block")
    const r3 = await handleSubagentStop({ project: p, session_id: SESS, run_id: "bad-a", event_seq: 3, last_assistant_message: msg })
    expect(r3.outcome).toBe("rejected")
  })

  test("idempotent duplicate SubagentStop → second is no-op, one ledger row", async () => {
    const p = setup()
    await runOnce(p, "idem-a", "implementer", implResult("idem-a", p, PIN))
    const r2 = await handleSubagentStop({ project: p, session_id: SESS, run_id: "idem-a", event_seq: 99, last_assistant_message: implResult("idem-a", p, PIN) })
    expect(r2.outcome).toBe("accepted_verified") // returns prior, no re-run
    const ledger = readFileSync(join(p, ".claude-hooks", "eventstore", "worker-acceptance.jsonl"), "utf8").trim().split("\n").filter((l) => l.includes("idem-a"))
    expect(ledger.length).toBe(1)
  })

  test("missing SubagentStart → soft_failed, no disk reread", async () => {
    const p = setup()
    const r = await handleSubagentStop({ project: p, session_id: SESS, run_id: "ghost", event_seq: 1, last_assistant_message: implResult("ghost", p, PIN) })
    expect(r.outcome).toBe("soft_failed")
  })

  test("scout → well_formed, never accepted", async () => {
    const p = setup()
    const scout = JSON.stringify({ label: "look", question: "where", findings: [], coverage: { examined: [], not_examined: ["x"] }, unknowns: ["unanswerable"] })
    const r = await runOnce(p, "look", "scout", scout)
    expect(r.outcome).toBe("well_formed")
  })

  test("signed verdict verifies; tamper fails", async () => {
    const p = setup()
    await runOnce(p, "sig-a", "implementer", implResult("sig-a", p, PIN))
    const v = loadVerdict(p, SESS, "sig-a")!
    expect(verifyVerdict(p, v)).toBe(true)
    const tampered: Verdict = { ...v, outcome: "rejected" }
    expect(verifyVerdict(p, tampered)).toBe(false)
  })

  test("evidence goes stale when a file_scope file changes → Stop blocks (fix #2)", async () => {
    const p = setup()
    const brief: WorkerBrief = { schema_version: 1, role: "implementer", label: "stale-a", isa_path: ".claude-hooks/ISA.md", isc_id: "ISC9", files_in_scope: ["src.ts"], acceptance: { argv: PIN, cwd: ".", replay: "required", idempotent: true } }
    await runOnce(p, "stale-a", "implementer", implResult("stale-a", p, PIN), true, brief)
    expect(handleStop(p, SESS, [{ isc: "ISC9", required: true }]).decision).toBe("pass")
    writeFileSync(join(p, "src.ts"), "CHANGED\n") // the verified file mutates
    const after = handleStop(p, SESS, [{ isc: "ISC9", required: true }])
    expect(after.decision).toBe("block")
    expect(after.reason).toContain("stale")
    expect(loadEvidence(p, SESS, "ISC9")?.status).toBe("stale")
  })
})

describe("gates via dispatch (§12)", () => {
  test("scout worker: Write denied by capability", () => {
    const p = setup()
    handleSubagentStart({ project: p, session_id: SESS, run_id: "sc", agent_id: "sc", parent_run_id: null, agent_type: "scout", label: "sc" })
    const d = handlePreToolUse({ project: p, session_id: SESS, run_id: "sc", tool_name: "Write", tool_input: { file_path: "src/x.ts" } })
    expect(d.kind).toBe("deny")
  })
  test("scout cannot spawn implementer (capability widening)", () => {
    const p = setup()
    handleSubagentStart({ project: p, session_id: SESS, run_id: "sc2", agent_id: "sc2", parent_run_id: null, agent_type: "scout", label: "sc2" })
    const d = handlePreToolUse({ project: p, session_id: SESS, run_id: "sc2", tool_name: "Agent", tool_input: { subagent_type: "implementer", label: "child" } })
    expect(d.kind).toBe("deny")
  })
  test("malformed PreToolUse Bash → ask", () => {
    const p = setup()
    expect(handlePreToolUse({ project: p, session_id: SESS, run_id: null, tool_name: "Bash", tool_input: {} }).kind).toBe("ask")
  })
  test("orchestrator destructive bash → deny", () => {
    const p = setup()
    expect(handlePreToolUse({ project: p, session_id: SESS, run_id: null, tool_name: "Bash", tool_input: { command: "rm -rf /" } }).kind).toBe("deny")
  })
})

describe("evidential completion gate (F1, §6.4)", () => {
  const SPINE = (overrides: Partial<WorkerBrief> = {}): WorkerBrief => ({
    schema_version: 1, role: "implementer", label: "spine-x", isa_path: "ISA.md", isc_id: "ISC1",
    files_in_scope: ["src.ts"], acceptance: { argv: PIN, cwd: ".", replay: "required", idempotent: true }, ...overrides,
  })
  const writeIsa = (p: string, phase: string, isc: string[]) =>
    writeFileSync(join(p, "ISA.md"), `---\neffort: E3\nphase: ${phase}\n---\n\n## Goal\nship it\n\n## Criteria\n${isc.join("\n")}\n`)

  test("phase: complete, declared ISC with no evidence → block (was vacuous)", () => {
    const p = setup()
    writeIsa(p, "complete", ["- [ ] ISC1: it works"])
    const r = handleStop(p, SESS, [])
    expect(r.decision).toBe("block")
    expect(r.reason).toContain("ISC1")
  })

  test("phase: complete, zero ## Criteria → block (empty-stub bypass)", () => {
    const p = setup()
    writeIsa(p, "complete", [])
    const r = handleStop(p, SESS, [])
    expect(r.decision).toBe("block")
    expect(r.reason).toContain("zero")
  })

  test("phase: complete, ISC flipped by verified replay → pass", async () => {
    const p = setup()
    await runOnce(p, "spine-x", "implementer", implResult("spine-x", p, PIN), true, SPINE())
    expect(loadEvidence(p, SESS, "ISC1")?.trust_label).toBe("verified")
    writeIsa(p, "complete", ["- [x] ISC1: it works"])
    expect(handleStop(p, SESS, []).decision).toBe("pass")
  })

  test("phase: complete, verified ISC then scope file mutates → stale → block", async () => {
    const p = setup()
    await runOnce(p, "spine-y", "implementer", implResult("spine-y", p, PIN), true, SPINE({ label: "spine-y" }))
    writeIsa(p, "complete", ["- [x] ISC1: it works"])
    expect(handleStop(p, SESS, []).decision).toBe("pass")
    writeFileSync(join(p, "src.ts"), "CHANGED\n")
    expect(handleStop(p, SESS, []).decision).toBe("block")
  })

  test("ISA present but phase != complete → no completion block (work in progress)", () => {
    const p = setup()
    writeIsa(p, "in_progress", ["- [ ] ISC1: pending"])
    expect(handleStop(p, SESS, []).decision).toBe("pass")
  })

  test("no ISA → gate does not bind", () => {
    const p = setup()
    expect(handleStop(p, SESS, []).decision).toBe("pass")
  })
})

describe("honest trust labels (F9)", () => {
  function cleanRepo(): string {
    const d = mkdtempSync(join(tmpdir(), "ws-"))
    spawnSync("git", ["init", "-q"], { cwd: d })
    writeFileSync(join(d, "f.txt"), "x\n")
    spawnSync("git", ["add", "-A"], { cwd: d }); spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "b"], { cwd: d })
    return d
  }
  test("skeptic without reproduction → accepted but trust none / advisory, not verified", async () => {
    const p = setup()
    const ws = cleanRepo()
    registerBrief(p, { schema_version: 1, role: "skeptic", label: "sk1" } as WorkerBrief)
    handleSubagentStart({ project: p, session_id: SESS, run_id: "sk1", agent_id: "sk1", parent_run_id: null, agent_type: "skeptic", label: "sk1" })
    const msg = JSON.stringify({ label: "sk1", claim: "x holds", verdict: "confirmed", workspace: { root: ws }, caveats: ["scoped"] })
    const r = await handleSubagentStop({ project: p, session_id: SESS, run_id: "sk1", event_seq: 1, last_assistant_message: msg })
    expect(r.outcome).toBe("accepted_verified")
    const v = loadVerdict(p, SESS, "sk1")!
    expect(v.trust_label).toBe("none")
    expect(v.advice).toContain("advisory")
  })
})
