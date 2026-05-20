/**
 * Regression pins for the 4 enforcement-plane P1s confirmed by the
 * 2026-05-20 Opus diligence:
 *
 *   #1 — Stale project `<repo>/ISA.md` releases a new engagement
 *   #4 — engagement_required + null expected_isa_path fails open
 *   #5 — NotebookEdit invisible to files_changed
 *   #7 — source_ledger_opt_out persists across prompts
 *
 * Each test is structured to FAIL pre-fix and PASS after.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveActiveIsa } from "../src/algorithm/isa/lifecycle.ts"
import {
  evaluateEngagementGate,
  evaluateEngagementGateShallow,
} from "../src/policies/engagement-gate.ts"
import { handlePostToolUse } from "../src/events/post-edit-quality.ts"
import { handleUserPromptSubmit } from "../src/events/prompt-router.ts"
import { HookPayload } from "../src/schema/payloads.ts"
import { ProjectTest } from "../src/services/project.ts"
import { RedactTest } from "../src/services/redact.ts"
import { ShellTest } from "../src/services/shell.ts"
import {
  EMPTY_SESSION_STATE,
  SessionState,
  SessionStateTest,
} from "../src/services/session-state.ts"
import {
  ClaudeSubprocessTest,
} from "../src/services/claude-subprocess.ts"
import { InferenceTest, FAIL_SAFE } from "../src/services/inference.ts"
import { ClassifierTelemetryTest } from "../src/services/classifier-telemetry.ts"
import { CommandRunnerTest } from "../src/services/command-runner.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

// ────────────────────────────────────────────────────────────────────────
// #1 — Stale project ISA freshness check
// ────────────────────────────────────────────────────────────────────────

describe("Enforcement P1 #1 — stale project ISA does not release a new engagement", () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ep1-stale-isa-"))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const stampMtime = (path: string, msEpoch: number) => {
    const sec = msEpoch / 1000
    utimesSync(path, sec, sec)
  }

  test("stale project ISA + engaged session → returns null (NOT the stale ISA)", () => {
    const projectIsa = join(root, "ISA.md")
    writeFileSync(projectIsa, "---\nphase: complete\n---\nstale\n", "utf8")
    // Stamp 1 hour ago
    stampMtime(projectIsa, Date.now() - 3_600_000)
    // Engaged NOW with no expected ISA on disk yet.
    const result = resolveActiveIsa({
      sessionRoot: root,
      record: {
        engagement_required: true,
        expected_isa_path:
          ".claude-hooks/work/new-session/ISA.md",
        expected_isa_path_absolute: join(
          root,
          ".claude-hooks/work/new-session/ISA.md",
        ),
        isa_engaged_at: new Date().toISOString(),
        last_mode: "ALGORITHM",
        last_tier: 3,
      },
    })
    expect(result).toBeNull()
  })

  test("fresh project ISA (mtime > isa_engaged_at) + engaged session → returns project ISA", () => {
    const projectIsa = join(root, "ISA.md")
    writeFileSync(projectIsa, "---\nphase: observe\n---\nfresh\n", "utf8")
    // Engagement created an hour ago; ISA was just edited.
    const engagedAt = new Date(Date.now() - 3_600_000)
    stampMtime(projectIsa, Date.now()) // now
    const result = resolveActiveIsa({
      sessionRoot: root,
      record: {
        engagement_required: true,
        expected_isa_path:
          ".claude-hooks/work/new-session/ISA.md",
        expected_isa_path_absolute: join(
          root,
          ".claude-hooks/work/new-session/ISA.md",
        ),
        isa_engaged_at: engagedAt.toISOString(),
        last_mode: "ALGORITHM",
        last_tier: 3,
      },
    })
    expect(result).toBe(projectIsa)
  })

  test("non-engaged session + project ISA → returns project ISA (legacy behavior preserved)", () => {
    const projectIsa = join(root, "ISA.md")
    writeFileSync(projectIsa, "---\nphase: complete\n---\nold\n", "utf8")
    stampMtime(projectIsa, Date.now() - 86_400_000) // a day ago
    const result = resolveActiveIsa({
      sessionRoot: root,
      record: {
        engagement_required: false,
        expected_isa_path: null,
        expected_isa_path_absolute: null,
        isa_engaged_at: null,
        last_mode: null,
        last_tier: null,
      },
    })
    expect(result).toBe(projectIsa)
  })

  test("engaged but no isa_engaged_at (legacy caller) → returns project ISA (back-compat)", () => {
    const projectIsa = join(root, "ISA.md")
    writeFileSync(projectIsa, "---\nphase: complete\n---\nold\n", "utf8")
    stampMtime(projectIsa, Date.now() - 86_400_000)
    const result = resolveActiveIsa({
      sessionRoot: root,
      record: {
        engagement_required: true,
        expected_isa_path: ".claude-hooks/work/x/ISA.md",
        expected_isa_path_absolute: join(root, ".claude-hooks/work/x/ISA.md"),
        // isa_engaged_at omitted (legacy caller via ResolveActiveIsaRecord)
        last_mode: "ALGORITHM",
        last_tier: 3,
      },
    })
    expect(result).toBe(projectIsa)
  })
})

// ────────────────────────────────────────────────────────────────────────
// #4 — corrupt engagement state (engagement_required=true + null path)
// ────────────────────────────────────────────────────────────────────────

describe("Enforcement P1 #4 — engagement_required + null expected_isa_path → ask", () => {
  // The DEEP entry (`evaluateEngagementGate`) is where #4 lives. Pre-fix
  // the check at engagement-gate.ts:363 returned passthrough, disabling
  // the gate exactly when state said engagement was required. Now it
  // returns `ask` with a repair message.

  test("Write with engagement_required=true + expected_isa_path=null → ask", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "ep1-corrupt-state-"))
    try {
      const v = evaluateEngagementGate({
        currentCwd: tmpRoot,
        sessionRoot: tmpRoot,
        toolName: "Write",
        toolInput: { file_path: join(tmpRoot, "src", "x.ts") },
        record: {
          ...EMPTY_SESSION_STATE,
          engagement_required: true,
          expected_isa_path: null,
          last_tier: 3,
        },
      })
      expect(v.kind).toBe("ask")
      if (v.kind === "ask") {
        expect(v.reason).toContain("corrupt")
        expect(v.reason).toContain("expected_isa_path")
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test("non-corrupt state (expected_isa_path set) does NOT trigger the ask branch", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "ep1-noncorrupt-"))
    try {
      const v = evaluateEngagementGate({
        currentCwd: tmpRoot,
        sessionRoot: tmpRoot,
        toolName: "Read", // read should passthrough regardless
        toolInput: { file_path: join(tmpRoot, "src", "x.ts") },
        record: {
          ...EMPTY_SESSION_STATE,
          engagement_required: true,
          expected_isa_path: ".claude-hooks/work/s/ISA.md",
          last_tier: 3,
        },
      })
      expect(v.kind).toBe("passthrough")
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test("engagement_required=false + null expected_isa_path → passthrough (not corrupt)", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "ep1-notengaged-"))
    try {
      const v = evaluateEngagementGate({
        currentCwd: tmpRoot,
        sessionRoot: tmpRoot,
        toolName: "Write",
        toolInput: { file_path: join(tmpRoot, "src", "x.ts") },
        record: {
          ...EMPTY_SESSION_STATE,
          engagement_required: false,
          expected_isa_path: null,
        },
      })
      expect(v.kind).toBe("passthrough")
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})

// ────────────────────────────────────────────────────────────────────────
// #5 — NotebookEdit now sets files_changed
// ────────────────────────────────────────────────────────────────────────

describe("Enforcement P1 #5 — NotebookEdit recorded in files_changed", () => {
  const layer = Layer.mergeAll(
    ProjectTest(),
    RedactTest(),
    SessionStateTest(),
    ShellTest(() => ({ stdout: "", stderr: "", exitCode: 1 })),
  )

  test("NotebookEdit with notebook_path → state.files_changed includes the path", async () => {
    const payload = decode({
      _tag: "PostToolUse",
      session_id: "s",
      hook_event_name: "PostToolUse",
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: "/repo/notebooks/analysis.ipynb" },
      tool_response: { success: true },
    })
    const program = Effect.gen(function* () {
      yield* handlePostToolUse(payload)
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(record.files_changed).toContain("/repo/notebooks/analysis.ipynb")
    expect(record.verification_status).toBe("none")
  })

  test("empty-string file_path → NOT recorded (delegation to mutablePathFromInput)", async () => {
    // PR #73 review non-blocker #4: pinning the intentional behavior
    // change. Pre-fix `filePathFromInput` returned "" for {file_path:""};
    // post-fix `mutablePathFromInput` rejects empty/whitespace-only and
    // returns null, so the path is not recorded. Empty `file_path` was
    // never a meaningful PostToolUse signal — this pin documents the
    // behavior and prevents accidental re-introduction.
    const payload = decode({
      _tag: "PostToolUse",
      session_id: "s",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "" },
      tool_response: { success: true },
    })
    const program = Effect.gen(function* () {
      yield* handlePostToolUse(payload)
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(record.files_changed).not.toContain("")
    expect(record.files_changed.length).toBe(0)
  })

  test("Update with file_path also recorded (already-fixed sanity check)", async () => {
    const payload = decode({
      _tag: "PostToolUse",
      session_id: "s",
      hook_event_name: "PostToolUse",
      tool_name: "Update",
      tool_input: { file_path: "/repo/src/foo.ts" },
      tool_response: { success: true },
    })
    const program = Effect.gen(function* () {
      yield* handlePostToolUse(payload)
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(record.files_changed).toContain("/repo/src/foo.ts")
  })
})

// ────────────────────────────────────────────────────────────────────────
// #7 — source_ledger_opt_out reset on new source-required prompt
// ────────────────────────────────────────────────────────────────────────

describe("Enforcement P1 #7 — source_ledger_opt_out reset on new source-required prompt", () => {
  const inferenceLayer = InferenceTest(() => ({
    ...FAIL_SAFE,
    reason: "test default → ALGORITHM E3",
    latencyMs: 0,
  }))
  const subprocLayer = ClaudeSubprocessTest()

  test("seeded opt_out=true + web-source prompt → state.source_ledger_opt_out flips to false", async () => {
    const initial = new Map([
      [
        "s",
        {
          ...EMPTY_SESSION_STATE,
          source_ledger_opt_out: true,
        },
      ],
    ])
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "s",
      hook_event_name: "UserPromptSubmit",
      prompt: "Search the web for best practices on rate limiting.",
    })
    const program = Effect.gen(function* () {
      yield* handleUserPromptSubmit(payload)
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(
      program.pipe(
        Effect.provide(SessionStateTest(initial)),
        Effect.provide(inferenceLayer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
        Effect.provide(CommandRunnerTest()),
      ),
    )
    expect(record.requires_web_sources).toBe(true)
    expect(record.source_ledger_opt_out).toBe(false)
  })

  test("seeded opt_out=true + non-source-required prompt → opt_out unchanged (true)", async () => {
    const initial = new Map([
      [
        "s",
        {
          ...EMPTY_SESSION_STATE,
          source_ledger_opt_out: true,
        },
      ],
    ])
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "s",
      hook_event_name: "UserPromptSubmit",
      prompt: "Refactor this module to use the new API.",
    })
    const program = Effect.gen(function* () {
      yield* handleUserPromptSubmit(payload)
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(
      program.pipe(
        Effect.provide(SessionStateTest(initial)),
        Effect.provide(inferenceLayer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
        Effect.provide(CommandRunnerTest()),
      ),
    )
    expect(record.source_ledger_opt_out).toBe(true)
  })
})
