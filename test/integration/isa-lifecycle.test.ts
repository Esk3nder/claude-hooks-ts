/**
 * ISA lifecycle choreography — integration suite.
 *
 * Where the per-handler tests prove each gate in isolation against
 * curated inputs, this suite drives the real handlers end-to-end through
 * the prompt → gate → write → probe → checkpoint → stop chain. It is the
 * regression net for the SessionState split that follows: each scenario
 * encodes one invariant that must not regress as the record is broken
 * into engagement/verification/mode-cache services.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { handlePreToolUse } from "../../src/events/pretool-policy.ts"
import { handlePostToolUse } from "../../src/events/post-edit-quality.ts"
import { handleStop } from "../../src/events/stop-definition-of-done.ts"
import { handleUserPromptSubmit } from "../../src/events/prompt-router.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { FAIL_SAFE, InferenceTest } from "../../src/services/inference.ts"
import { ClaudeSubprocessTest } from "../../src/services/claude-subprocess.ts"
import { ClassifierTelemetryTest } from "../../src/services/classifier-telemetry.ts"
import { ProjectTest } from "../../src/services/project.ts"
import { RedactTest } from "../../src/services/redact.ts"
import { ShellTest } from "../../src/services/shell.ts"
import {
  EMPTY_SESSION_STATE,
  SessionState,
  SessionStateTest,
  type SessionStateRecord,
} from "../../src/services/session-state.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

interface Staged {
  readonly root: string
  readonly cleanup: () => void
}

/**
 * realpath-normalize so paths frozen into SessionState match the realpath
 * form that gates produce internally. On macOS /tmp is a symlink to
 * /private/tmp.
 */
const stage = (label: string): Staged => {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), `chts-isa-${label}-`))
  const root = fs.realpathSync(raw)
  return {
    root,
    cleanup: () => fs.rmSync(raw, { recursive: true, force: true }),
  }
}

const initGitRepo = (dir: string): void => {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync("git", ["-C", dir, "init", "--quiet", "-b", "main"], {
    stdio: "ignore",
  })
  execFileSync(
    "git",
    ["-C", dir, "config", "user.email", "test@example.com"],
    { stdio: "ignore" },
  )
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"], {
    stdio: "ignore",
  })
  execFileSync("git", ["-C", dir, "config", "commit.gpgsign", "false"], {
    stdio: "ignore",
  })
}

const ISA_E3_BODY = `---
effort: advanced
phase: observe
---

## Problem
x

## Vision
y

## Out of Scope
none

## Constraints
none

## Goal
ship

## Criteria
- [ ] ISC-1: do the thing

## Features
- one

## Test Strategy
| ISC | Description | Probe |
| --- | --- | --- |
| ISC-1 | do the thing | pass-isc-1 |
`

const seed = (
  sessionId: string,
  patch: Partial<SessionStateRecord>,
): Map<string, SessionStateRecord> =>
  new Map([[sessionId, { ...EMPTY_SESSION_STATE, ...patch }]])

const ENGAGED = (root: string, sessionId: string): Partial<SessionStateRecord> => {
  const rel = `.claude-hooks/work/${sessionId}/ISA.md`
  return {
    engagement_required: true,
    last_mode: "ALGORITHM",
    last_tier: 3,
    expected_isa_path: rel,
    expected_isa_path_absolute: path.join(root, rel),
    session_root: root,
  }
}

describe("ISA lifecycle integration — choreography", () => {
  // Scenario 1: UserPromptSubmit on an ALGORITHM E3+ prompt records the
  // engagement bookkeeping the downstream gates need.
  test("1. E3 ALGORITHM prompt records engagement state", async () => {
    const { root, cleanup } = stage("s1")
    try {
      const sid = "s1"
      const state = SessionStateTest()
      const inference = InferenceTest(() => ({
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
      const record = await Effect.runPromise(
        Effect.gen(function* () {
          yield* handleUserPromptSubmit(payload)
          const s = yield* SessionState
          return yield* s.get(sid)
        }).pipe(
          Effect.provide(state),
          Effect.provide(inference),
          Effect.provide(ClaudeSubprocessTest()),
          Effect.provide(ClassifierTelemetryTest().layer),
        ),
      )
      expect(record.engagement_required).toBe(true)
      expect(record.expected_isa_path).not.toBeNull()
      expect(record.session_root).not.toBeNull()
      expect(record.last_tier).toBe(3)
      expect(record.last_mode).toBe("ALGORITHM")
    } finally {
      cleanup()
    }
  })

  // Scenario 2: with engagement frozen and no ISA on disk, a Write to an
  // unrelated path is denied — and the denial reason names the ISA path.
  test("2. PreTool Write to unrelated path before ISA exists → deny", async () => {
    const { root, cleanup } = stage("s2")
    try {
      const sid = "s2"
      const target = path.join(root, "src", "unrelated.ts")
      const payload = decode({
        _tag: "PreToolUse",
        session_id: sid,
        hook_event_name: "PreToolUse",
        cwd: root,
        tool_name: "Write",
        tool_input: { file_path: target, content: "x" },
      })
      const out = (await Effect.runPromise(
        handlePreToolUse(payload).pipe(
          Effect.provide(SessionStateTest(seed(sid, ENGAGED(root, sid)))),
        ),
      )) as {
        hookSpecificOutput?: {
          permissionDecision?: string
          permissionDecisionReason?: string
        }
      }
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny")
      const reason = out.hookSpecificOutput?.permissionDecisionReason ?? ""
      expect(reason).toContain(
        `.claude-hooks/work/${sid}/ISA.md`,
      )
    } finally {
      cleanup()
    }
  })

  // Scenario 3: same state, Write directly to the expected ISA path is
  // not blocked — that's how the model satisfies the engagement directive.
  test("3. PreTool Write to expected ISA path → allow", async () => {
    const { root, cleanup } = stage("s3")
    try {
      const sid = "s3"
      const isaAbs = path.join(root, `.claude-hooks/work/${sid}/ISA.md`)
      const payload = decode({
        _tag: "PreToolUse",
        session_id: sid,
        hook_event_name: "PreToolUse",
        cwd: root,
        tool_name: "Write",
        tool_input: { file_path: isaAbs, content: "---\n---\n" },
      })
      const out = (await Effect.runPromise(
        handlePreToolUse(payload).pipe(
          Effect.provide(SessionStateTest(seed(sid, ENGAGED(root, sid)))),
        ),
      )) as {
        hookSpecificOutput?: { permissionDecision?: string }
      }
      expect(out.hookSpecificOutput?.permissionDecision).not.toBe("deny")
    } finally {
      cleanup()
    }
  })

  // Scenario 4: once the ISA exists on disk, the gate releases — unrelated
  // Writes are no longer blocked.
  test("4. Once ISA exists, PreTool Write to unrelated path → allow", async () => {
    const { root, cleanup } = stage("s4")
    try {
      const sid = "s4"
      const isaDir = path.join(root, ".claude-hooks", "work", sid)
      fs.mkdirSync(isaDir, { recursive: true })
      fs.writeFileSync(path.join(isaDir, "ISA.md"), ISA_E3_BODY, "utf-8")
      const unrelated = path.join(root, "src", "foo.ts")
      const payload = decode({
        _tag: "PreToolUse",
        session_id: sid,
        hook_event_name: "PreToolUse",
        cwd: root,
        tool_name: "Write",
        tool_input: { file_path: unrelated, content: "x" },
      })
      const out = (await Effect.runPromise(
        handlePreToolUse(payload).pipe(
          Effect.provide(SessionStateTest(seed(sid, ENGAGED(root, sid)))),
        ),
      )) as { hookSpecificOutput?: { permissionDecision?: string } }
      expect(out.hookSpecificOutput?.permissionDecision).not.toBe("deny")
    } finally {
      cleanup()
    }
  })

  // Scenario 5: Stop with E3+ engagement and no ISA fires the
  // absence-is-failure gate exactly once, then releases.
  test("5. Stop after E3+ with no ISA → block once, then allow", async () => {
    const { root, cleanup } = stage("s5")
    try {
      const sid = "s5"
      const state = SessionStateTest(seed(sid, ENGAGED(root, sid)))
      const payload = decode({
        _tag: "Stop",
        session_id: sid,
        hook_event_name: "Stop",
        cwd: root,
      })
      // Both calls must share the same materialized Ref so the
      // stop_blocked_once flag persists between them. Layer.effect-based
      // SessionStateTest builds a fresh Ref per Effect.provide.
      const both = (await Effect.runPromise(
        Effect.gen(function* () {
          const f = yield* handleStop(payload)
          const s = yield* handleStop(payload)
          return { first: f, second: s }
        }).pipe(Effect.provide(state)),
      )) as {
        first: { decision?: string; reason?: string }
        second: { decision?: string }
      }
      expect(both.first.decision).toBe("block")
      expect(both.first.reason ?? "").toContain("without an ISA")
      expect(both.second.decision).not.toBe("block")
    } finally {
      cleanup()
    }
  })

  // Scenario 6: ISA on disk with phase: complete but unchecked ISC blocks
  // Stop — the completeness gate reads frontmatter + criteria from disk
  // and dominates the absence gate.
  test("6. Stop with ISA phase: complete but unchecked ISC → block", async () => {
    const { root, cleanup } = stage("s6")
    try {
      const sid = "s6"
      const isaDir = path.join(root, ".claude-hooks", "work", sid)
      fs.mkdirSync(isaDir, { recursive: true })
      const body = ISA_E3_BODY.replace("phase: observe", "phase: complete")
      fs.writeFileSync(path.join(isaDir, "ISA.md"), body, "utf-8")
      const state = SessionStateTest(seed(sid, ENGAGED(root, sid)))
      const out = (await Effect.runPromise(
        handleStop(
          decode({
            _tag: "Stop",
            session_id: sid,
            hook_event_name: "Stop",
            cwd: root,
          }),
        ).pipe(Effect.provide(state)),
      )) as { decision?: string; reason?: string }
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("unchecked")
    } finally {
      cleanup()
    }
  })

  // Scenario 7: probe pass → checkbox flip → checkpoint commit is one
  // atomic operation. F3-class invariant — flip without commit would
  // leave the ISA "complete" without the audit trail.
  describe("7. PostToolUse probe-flip is atomic with checkpoint", () => {
    let savedCwd: string
    beforeEach(() => {
      savedCwd = process.cwd()
    })
    afterEach(() => {
      try {
        process.chdir(savedCwd)
      } catch {
        // ignore — temp dir may have been cleaned
      }
    })

    test("probe flips ISC-1 and a checkpoint commit is made", async () => {
      const { root, cleanup } = stage("s7")
      try {
        const sid = "s7"
        // Git repo at root — checkpoint needs an allowlisted repo to
        // actually commit. ISA lives inside it.
        initGitRepo(root)
        // Allowlist this repo for checkpoint.
        fs.mkdirSync(path.join(root, ".claude-hooks"), { recursive: true })
        fs.writeFileSync(
          path.join(root, ".claude-hooks", "checkpoint-repos.txt"),
          `${root}\n`,
          "utf-8",
        )
        // Place ISA at the project root (findProjectIsa).
        const isaPath = path.join(root, "ISA.md")
        fs.writeFileSync(isaPath, ISA_E3_BODY, "utf-8")
        // Probe registry — `pass-isc-1` always returns true.
        fs.writeFileSync(
          path.join(root, ".claude-hooks", "probes.ts"),
          `export const probes = { "pass-isc-1": () => true }\n`,
          "utf-8",
        )
        // Some unrelated source file the probe "touches"; the handler
        // doesn't actually consult file_path here, but we keep the shape
        // honest.
        const touched = path.join(root, "src", "touched.ts")
        fs.mkdirSync(path.dirname(touched), { recursive: true })
        fs.writeFileSync(touched, "// hi\n", "utf-8")
        // Commit the seeds so `git status` is clean before the flip.
        execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" })
        execFileSync(
          "git",
          ["-C", root, "commit", "-m", "seed", "--no-verify"],
          { stdio: "ignore" },
        )

        process.chdir(root)

        const payload = decode({
          _tag: "PostToolUse",
          session_id: sid,
          hook_event_name: "PostToolUse",
          tool_name: "Edit",
          tool_input: { file_path: touched },
          tool_response: { success: true },
        })
        const layer = Layer.mergeAll(
          ProjectTest(),
          RedactTest(),
          SessionStateTest(seed(sid, ENGAGED(root, sid))),
          ShellTest(() => ({ stdout: "", stderr: "", exitCode: 0 })),
        )
        await Effect.runPromise(
          handlePostToolUse(payload).pipe(Effect.provide(layer)),
        )

        // (a) ISA on disk now has ISC-1 checked.
        const afterIsa = fs.readFileSync(isaPath, "utf-8")
        expect(afterIsa).toMatch(/^- \[x\] ISC-1/m)

        // (b) Sidecar state file recorded the commit (checkpoint's
        // observable proof that flip+commit ran atomically). The
        // sidecar lives at `<repo>/.claude-hooks-checkpoint-state.json`
        // and only records committed_iscs when ≥1 repo actually committed.
        // Sidecar lives alongside the ISA (one per ISA dir). For a
        // project-root ISA, that's `<repo>/.checkpoint-state.json`.
        const sidecar = path.join(root, ".checkpoint-state.json")
        expect(fs.existsSync(sidecar)).toBe(true)
        const parsed = JSON.parse(fs.readFileSync(sidecar, "utf-8")) as {
          committed_iscs: string[]
        }
        expect(parsed.committed_iscs).toContain("ISC-1")
      } finally {
        cleanup()
      }
    })
  })
})
