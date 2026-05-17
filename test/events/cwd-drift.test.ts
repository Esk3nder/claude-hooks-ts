/**
 * cwd-drift regression — ISA identity must be frozen at engagement creation
 * and survive a later Bash `cd`.
 *
 * Before the fix: the engagement gate stored `expected_isa_path` as a
 * relative string and re-resolved it against `payload.cwd` on every hook
 * invocation. After Bash `cd ~/.claude/skills/...`, the gate looked for the
 * ISA under the skill directory, denied unrelated PreToolUse calls, and
 * Stop falsely reported "ALGORITHM run is finishing without an ISA."
 *
 * After the fix: `session_root` and `expected_isa_path_absolute` are frozen
 * when engagement is declared. The PreToolUse gate, Stop ISA lookup, and
 * TaskCompleted evidence gate all use the frozen root for ISA identity;
 * only tool input paths (the model's own `file_path` arg) and cwd-scoped
 * policies (regenerate rules) still resolve against the current cwd.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { handlePreToolUse } from "../../src/events/pretool-policy.ts"
import { handleStop } from "../../src/events/stop-definition-of-done.ts"
import { handleTaskCompleted } from "../../src/events/task-integrity.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import {
  SessionStateTest,
  EMPTY_SESSION_STATE,
  type SessionStateRecord,
} from "../../src/services/session-state.ts"
import { CommandRunnerTest } from "../../src/services/command-runner.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const stage = (
  label: string,
): { root: string; drift: string; cleanup: () => void } => {
  // realpath-normalize so the test's frozen-state paths match the
  // realpath form `safeResolvePath` produces inside the gate. On macOS
  // /tmp is a symlink to /private/tmp; without this both sides would
  // mismatch on the symlink even though they point to the same dir.
  const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), `chts-drift-${label}-`))
  const rawDrift = fs.mkdtempSync(path.join(os.tmpdir(), `chts-drift-d-`))
  const root = fs.realpathSync(rawRoot)
  const drift = fs.realpathSync(rawDrift)
  return {
    root,
    drift,
    cleanup: () => {
      fs.rmSync(rawRoot, { recursive: true, force: true })
      fs.rmSync(rawDrift, { recursive: true, force: true })
    },
  }
}

const SID = "drift-1"
const EXPECTED_REL = `.claude-hooks/work/${SID}/ISA.md`

const seedState = (
  partial: Partial<SessionStateRecord>,
): Map<string, SessionStateRecord> =>
  new Map([[SID, { ...EMPTY_SESSION_STATE, ...partial }]])

const runPretool = (
  cwd: string,
  toolName: string,
  toolInput: unknown,
  state: Partial<SessionStateRecord>,
): Promise<{
  hookSpecificOutput?: {
    permissionDecision?: string
    permissionDecisionReason?: string
  }
}> =>
  Effect.runPromise(
    handlePreToolUse(
      decode({
        _tag: "PreToolUse",
        session_id: SID,
        hook_event_name: "PreToolUse",
        cwd,
        tool_name: toolName,
        tool_input: toolInput,
      }),
    ).pipe(Effect.provide(SessionStateTest(seedState(state)))),
  ) as Promise<{
    hookSpecificOutput?: {
      permissionDecision?: string
      permissionDecisionReason?: string
    }
  }>

const runStop = (
  cwd: string,
  state: Partial<SessionStateRecord>,
): Promise<{ decision?: string; reason?: string }> =>
  Effect.runPromise(
    handleStop(
      decode({
        _tag: "Stop",
        session_id: SID,
        hook_event_name: "Stop",
        cwd,
      }),
    ).pipe(Effect.provide(SessionStateTest(seedState(state)))),
  ) as Promise<{ decision?: string; reason?: string }>

const runTaskCompleted = (
  cwd: string,
  state: Partial<SessionStateRecord>,
): Promise<{ decision?: string; reason?: string }> =>
  Effect.runPromise(
    handleTaskCompleted(
      decode({
        _tag: "TaskCompleted",
        session_id: SID,
        hook_event_name: "TaskCompleted",
        cwd,
        task_id: "t1",
        status: "ok",
      }),
    ).pipe(Effect.provide(SessionStateTest(seedState(state)))),
  ) as Promise<{ decision?: string; reason?: string }>

const ENGAGED = (root: string): Partial<SessionStateRecord> => ({
  engagement_required: true,
  last_mode: "ALGORITHM",
  last_tier: 3,
  expected_isa_path: EXPECTED_REL,
  expected_isa_path_absolute: path.join(root, EXPECTED_REL),
  session_root: root,
})

const COMPLETE_ENGAGED_ISA = `---
effort: advanced
phase: complete
classifier_mode: ALGORITHM
classifier_tier: E3
classifier_reason: cwd drift fixture
---

## Problem
x

## Vision
x

## Out of Scope
x

## Constraints
x

## Goal
x

## Criteria
- [x] ISC-1: x

## Test Strategy
ISC-1 | unit | x | x | x

## Features
x | ISC-1 | none | yes

## Verification
- ISC-1: fixture passed
`

describe("PreToolUse engagement gate — cwd drift", () => {
  test("Write to frozen repo ISA allowed after cwd drift", async () => {
    const { root, drift, cleanup } = stage("write-allow")
    try {
      const out = await runPretool(
        drift,
        "Write",
        {
          file_path: path.join(root, EXPECTED_REL),
          content: "---\n---\n",
        },
        ENGAGED(root),
      )
      expect(out.hookSpecificOutput?.permissionDecision).not.toBe("deny")
    } finally {
      cleanup()
    }
  })

  test("Relative ISA path under drifted cwd denied", async () => {
    const { root, drift, cleanup } = stage("rel-deny")
    try {
      // Relative file_path resolves against current cwd (= drift), which
      // would land outside the frozen session_root → deny.
      const out = await runPretool(
        drift,
        "Write",
        { file_path: EXPECTED_REL, content: "x" },
        ENGAGED(root),
      )
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny")
    } finally {
      cleanup()
    }
  })

  test("Relative mkdir under drifted cwd denied", async () => {
    const { root, drift, cleanup } = stage("mkdir-rel-deny")
    try {
      const out = await runPretool(
        drift,
        "Bash",
        { command: `mkdir -p .claude-hooks/work/${SID}` },
        ENGAGED(root),
      )
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny")
    } finally {
      cleanup()
    }
  })

  test("Absolute mkdir of frozen expected dir allowed even from drifted cwd", async () => {
    const { root, drift, cleanup } = stage("mkdir-abs-allow")
    try {
      const expectedDirAbs = path.join(root, ".claude-hooks", "work", SID)
      const out = await runPretool(
        drift,
        "Bash",
        { command: `mkdir -p ${expectedDirAbs}` },
        ENGAGED(root),
      )
      expect(out.hookSpecificOutput?.permissionDecision).not.toBe("deny")
    } finally {
      cleanup()
    }
  })

  test("Relative mkdir at session root still allowed (no drift)", async () => {
    const { root, cleanup } = stage("mkdir-norel-allow")
    try {
      const out = await runPretool(
        root,
        "Bash",
        { command: `mkdir -p .claude-hooks/work/${SID}` },
        ENGAGED(root),
      )
      expect(out.hookSpecificOutput?.permissionDecision).not.toBe("deny")
    } finally {
      cleanup()
    }
  })
})

describe("Stop ISA lookup — cwd drift", () => {
  test("Stop finds repo ISA after cwd drift", async () => {
    const { root, drift, cleanup } = stage("stop-find")
    try {
      // Plant an ISA under the frozen session_root.
      const isaDir = path.join(root, ".claude-hooks", "work", SID)
      fs.mkdirSync(isaDir, { recursive: true })
      fs.writeFileSync(
        path.join(isaDir, "ISA.md"),
        COMPLETE_ENGAGED_ISA,
        "utf-8",
      )
      const out = await runStop(drift, ENGAGED(root))
      // Stop should consult the ISA via session_root, not drifted cwd.
      expect(out.decision).not.toBe("block")
    } finally {
      cleanup()
    }
  })

  test("Drifted cwd has unrelated ISA; frozen session_root has none → Stop still blocks", async () => {
    const { root, drift, cleanup } = stage("stop-drift-ignored")
    try {
      // Plant an unrelated ISA under the DRIFT directory only.
      const driftIsaDir = path.join(drift, ".claude-hooks", "work", SID)
      fs.mkdirSync(driftIsaDir, { recursive: true })
      fs.writeFileSync(
        path.join(driftIsaDir, "ISA.md"),
        "---\neffort: advanced\nphase: observe\n---\n\n## Goal\nx\n",
        "utf-8",
      )
      const out = await runStop(drift, ENGAGED(root))
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("without an ISA")
    } finally {
      cleanup()
    }
  })
})

describe("TaskCompleted ISA evidence — cwd drift", () => {
  test("TaskCompleted reads ISA under session_root, not drifted cwd", async () => {
    const { root, drift, cleanup } = stage("task-find")
    try {
      // ISA at session_root with unchecked criteria.
      const isaDir = path.join(root, ".claude-hooks", "work", SID)
      fs.mkdirSync(isaDir, { recursive: true })
      fs.writeFileSync(
        path.join(isaDir, "ISA.md"),
        "---\neffort: advanced\nphase: observe\n---\n\n## Goal\nx\n\n## Criteria\n- [ ] ISC-1: still pending\n",
        "utf-8",
      )
      const out = await runTaskCompleted(drift, ENGAGED(root))
      // Should block on the unchecked-criteria reason from the frozen-root
      // ISA — proving the gate followed session_root and not drift cwd.
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("unchecked")
    } finally {
      cleanup()
    }
  })

  test("Drifted cwd ISA with checked criteria does NOT satisfy TaskCompleted when session_root has none", async () => {
    const { root, drift, cleanup } = stage("task-drift-ignored")
    try {
      // Plant a "complete" ISA only under the drift directory.
      const driftIsaDir = path.join(drift, ".claude-hooks", "work", SID)
      fs.mkdirSync(driftIsaDir, { recursive: true })
      fs.writeFileSync(
        path.join(driftIsaDir, "ISA.md"),
        "---\neffort: advanced\nphase: complete\n---\n\n## Goal\nx\n\n## Criteria\n- [x] ISC-1\n\n## Verification\n- ISC-1: done\n",
        "utf-8",
      )
      // Plant an UNCHECKED ISA at session_root so the ISA gate has
      // something to fire on if it correctly resolves to session_root.
      // Without this, the new "opt-in via signal" policy would pass
      // (no AC/evidence intent, no session_root ISA), and the test
      // couldn't distinguish "drift ISA invisible" from "gate disabled".
      const rootIsaDir = path.join(root, ".claude-hooks", "work", SID)
      fs.mkdirSync(rootIsaDir, { recursive: true })
      fs.writeFileSync(
        path.join(rootIsaDir, "ISA.md"),
        "---\neffort: advanced\nphase: observe\n---\n\n## Goal\nx\n\n## Criteria\n- [ ] ISC-1: still pending\n",
        "utf-8",
      )
      const out = await runTaskCompleted(drift, ENGAGED(root))
      // If the gate erroneously followed drift, it'd see the
      // all-checked-with-verification ISA and NO_DECISION. Using
      // session_root correctly, it sees the unchecked ISA and blocks.
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("unchecked")
    } finally {
      cleanup()
    }
  })
})

describe("Session-state forward-compat — legacy records without new fields", () => {
  test("old JSON missing session_root and expected_isa_path_absolute parses cleanly", async () => {
    // Simulate the on-disk path. Use SessionStateLive via a tmp root.
    const { SessionStateLive } = await import(
      "../../src/services/session-state.ts"
    )
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chts-legacy-"))
    try {
      const stateDir = path.join(tmp, ".claude-hooks", "state")
      fs.mkdirSync(stateDir, { recursive: true })
      const sid = "legacy-1"
      // A record that pre-dates the new fields (engagement bookkeeping
      // present, but no session_root / expected_isa_path_absolute).
      const legacy = {
        files_read: [],
        files_changed: [],
        commands_run: [],
        commands_failed: [],
        tests_run: [],
        verification_status: "none",
        next_required_action: null,
        stop_blocked_once: false,
        source_urls: [],
        subagent_starts: [],
        subagent_stops: [],
        last_workflow: null,
        last_mode: "ALGORITHM",
        last_tier: 3,
        engagement_required: true,
        expected_isa_path: ".claude-hooks/work/legacy-1/ISA.md",
        isa_engaged_at: null,
      }
      fs.writeFileSync(
        path.join(stateDir, `${sid}.json`),
        JSON.stringify(legacy),
        "utf-8",
      )
      const { SessionState } = await import(
        "../../src/services/session-state.ts"
      )
      const r = await Effect.runPromise(
        Effect.gen(function* () {
          const s = yield* SessionState
          return yield* s.get(sid)
        }).pipe(Effect.provide(SessionStateLive(tmp))),
      )
      // The decisive evidence the merge fired: engagement bookkeeping
      // survived. (Without the default-merge, the strict decode would
      // reject the missing fields and reset → engagement_required would
      // be false.)
      expect(r.engagement_required).toBe(true)
      expect(r.expected_isa_path).toBe(
        ".claude-hooks/work/legacy-1/ISA.md",
      )
      // New fields default to null on legacy records.
      expect(r.session_root).toBe(null)
      expect(r.expected_isa_path_absolute).toBe(null)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("UserPromptSubmit — frozen root is write-once across prompts", () => {
  // Regression: a second ALGORITHM E3+ prompt after Bash cd MUST NOT
  // overwrite the previously frozen session_root / expected_isa_path_absolute.
  // Without this guard, the gate is rooted at the drifted cwd on the next
  // prompt and the original frozen ISA becomes invisible again.
  test("repeated ALGORITHM prompt under drifted cwd preserves frozen root", async () => {
    const { handleUserPromptSubmit } = await import(
      "../../src/events/prompt-router.ts"
    )
    const { InferenceTest, FAIL_SAFE } = await import(
      "../../src/services/inference.ts"
    )
    const { ClaudeSubprocessTest } = await import(
      "../../src/services/claude-subprocess.ts"
    )
    const { ClassifierTelemetryTest } = await import(
      "../../src/services/classifier-telemetry.ts"
    )
    const { SessionState } = await import(
      "../../src/services/session-state.ts"
    )

    const { root, drift, cleanup } = stage("router-freeze")
    try {
      const sid = "router-freeze-1"
      const frozenAbs = path.join(root, EXPECTED_REL)
      const sharedState = SessionStateTest(
        new Map([
          [
            sid,
            {
              ...EMPTY_SESSION_STATE,
              engagement_required: true,
              last_mode: "ALGORITHM",
              last_tier: 3,
              expected_isa_path: EXPECTED_REL,
              expected_isa_path_absolute: frozenAbs,
              session_root: root,
            },
          ],
        ]),
      )
      const inferenceLayer = InferenceTest(() => ({
        ...FAIL_SAFE,
        reason: "test → ALGORITHM E3",
        latencyMs: 0,
      }))
      const payload = decode({
        _tag: "UserPromptSubmit",
        session_id: sid,
        hook_event_name: "UserPromptSubmit",
        cwd: drift,
        prompt: "design the new caching layer",
      })
      // Run handler AND state read inside the same Effect so both share
      // a single materialized SessionStateTest Ref.
      const after = await Effect.runPromise(
        Effect.gen(function* () {
          yield* handleUserPromptSubmit(payload)
          const s = yield* SessionState
          return yield* s.get(sid)
        }).pipe(
          Effect.provide(sharedState),
          Effect.provide(inferenceLayer),
          Effect.provide(ClaudeSubprocessTest()),
          Effect.provide(ClassifierTelemetryTest().layer),
          Effect.provide(CommandRunnerTest()),
        ),
      )
      expect(after.session_root).toBe(root)
      expect(after.expected_isa_path_absolute).toBe(frozenAbs)
    } finally {
      cleanup()
    }
  })

  test("first ALGORITHM prompt with no existing record still freezes a root", async () => {
    const { handleUserPromptSubmit } = await import(
      "../../src/events/prompt-router.ts"
    )
    const { InferenceTest, FAIL_SAFE } = await import(
      "../../src/services/inference.ts"
    )
    const { ClaudeSubprocessTest } = await import(
      "../../src/services/claude-subprocess.ts"
    )
    const { ClassifierTelemetryTest } = await import(
      "../../src/services/classifier-telemetry.ts"
    )
    const { SessionState } = await import(
      "../../src/services/session-state.ts"
    )

    const { root, cleanup } = stage("router-freeze-first")
    try {
      const sid = "router-freeze-2"
      const sharedState = SessionStateTest()
      const inferenceLayer = InferenceTest(() => ({
        ...FAIL_SAFE,
        reason: "test → ALGORITHM E3",
        latencyMs: 0,
      }))
      const payload = decode({
        _tag: "UserPromptSubmit",
        session_id: sid,
        hook_event_name: "UserPromptSubmit",
        cwd: root,
        prompt: "design the new caching layer",
      })
      const after = await Effect.runPromise(
        Effect.gen(function* () {
          yield* handleUserPromptSubmit(payload)
          const s = yield* SessionState
          return yield* s.get(sid)
        }).pipe(
          Effect.provide(sharedState),
          Effect.provide(inferenceLayer),
          Effect.provide(ClaudeSubprocessTest()),
          Effect.provide(ClassifierTelemetryTest().layer),
          Effect.provide(CommandRunnerTest()),
        ),
      )
      expect(after.engagement_required).toBe(true)
      expect(after.session_root).not.toBe(null)
      expect(after.expected_isa_path_absolute).not.toBe(null)
    } finally {
      cleanup()
    }
  })
})
