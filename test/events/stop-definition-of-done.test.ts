import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleStop } from "../../src/events/stop-definition-of-done.ts"
import { FsError } from "../../src/schema/errors.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import {
  SessionState,
  SessionStateTest,
  EMPTY_SESSION_STATE,
  type SessionStateApi,
} from "../../src/services/session-state.ts"
import { HookFailureTest } from "../../src/services/hook-failure.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const stop = (sid: string, assistant_message?: string) =>
  decode({
    _tag: "Stop",
    session_id: sid,
    hook_event_name: "Stop",
    ...(assistant_message === undefined ? {} : { assistant_message }),
  })

describe("handleStop (definition of done)", () => {
  test("red-team #5: blocks when files changed and no verification", async () => {
    const layer = SessionStateTest(
      new Map([
        [
          "sid-1",
          {
            ...EMPTY_SESSION_STATE,
            files_changed: ["/repo/a.ts"],
            verification_status: "none" as const,
          },
        ],
      ]),
    )
    const d = await Effect.runPromise(handleStop(stop("sid-1")).pipe(Effect.provide(layer)))
    const out = d as { decision?: string; reason?: string }
    expect(out.decision).toBe("block")
    expect(out.reason ?? "").toMatch(/verification/i)
  })

  test("stop_blocked_once does not suppress missing verification", async () => {
    const layer = SessionStateTest(
      new Map([
        [
          "sid-2",
          {
            ...EMPTY_SESSION_STATE,
            files_changed: ["/repo/a.ts"],
            verification_status: "none" as const,
            stop_blocked_once: true,
          },
        ],
      ]),
    )
    const d = await Effect.runPromise(
      handleStop(stop("sid-2")).pipe(Effect.provide(layer)),
    )
    const out = d as { decision?: string; reason?: string }
    expect(out.decision).toBe("block")
    expect(out.reason ?? "").toMatch(/verification/i)
  })

  test("verification readiness keeps blocking until verification is recorded", async () => {
    const layer = SessionStateTest(
      new Map([
        [
          "sid-3",
          {
            ...EMPTY_SESSION_STATE,
            files_changed: ["/repo/a.ts"],
            verification_status: "none" as const,
          },
        ],
      ]),
    )
    const program = Effect.gen(function* () {
      const first = yield* handleStop(stop("sid-3"))
      const s = yield* SessionState
      const stateAfter = yield* s.get("sid-3")
      const second = yield* handleStop(stop("sid-3"))
      return { first, stateAfter, second }
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect((r.first as { decision?: string }).decision).toBe("block")
    expect(r.stateAfter.stop_blocked_once).toBe(false)
    expect((r.second as { decision?: string }).decision).toBe("block")
  })

  test("allows stop when verification has passed", async () => {
    const layer = SessionStateTest(
      new Map([
        [
          "sid-4",
          {
            ...EMPTY_SESSION_STATE,
            files_changed: ["/repo/a.ts"],
            verification_status: "passed" as const,
            // PR: verify-watermark — the gate now keys "unverified files"
            // off `files_changed \ verification_files`, not on
            // `verification_status` alone. Files known-verified must be
            // listed here to skip the gate.
            verification_files: ["/repo/a.ts"],
          },
        ],
      ]),
    )
    const d = await Effect.runPromise(handleStop(stop("sid-4")).pipe(Effect.provide(layer)))
    expect(d).toEqual({})
  })

  test("allows stop when no files changed", async () => {
    const layer = SessionStateTest()
    const d = await Effect.runPromise(handleStop(stop("sid-5")).pipe(Effect.provide(layer)))
    expect(d).toEqual({})
  })

  test("blocks and reports typed failure when session state cannot be read", async () => {
    const failure = new FsError({
      op: "session-state.get",
      path: "/repo/.claude-hooks/state/sid-fail.json",
      message: "permission denied",
    })
    const stateLayer = Layer.succeed(
      SessionState,
      SessionState.of({
        get: (() => Effect.fail(failure)) as SessionStateApi["get"],
        update: (() => Effect.void) as SessionStateApi["update"],
        append: (() => Effect.void) as SessionStateApi["append"],
        appendBatch: (() => Effect.void) as SessionStateApi["appendBatch"],
        reset: () => Effect.void,
      }),
    )
    const hookFailure = HookFailureTest()

    const d = await Effect.runPromise(
      handleStop(stop("sid-fail")).pipe(
        Effect.provide(Layer.merge(stateLayer, hookFailure.layer)),
      ),
    )

    expect((d as { decision?: string }).decision).toBe("block")
    expect(hookFailure.records()[0]?.kind).toBe("state_read_failed")
    expect(hookFailure.records()[0]?.fallbackDecision).toMatchObject({
      decision: "block",
    })
  })

  test("payload may carry assistant_message field (per official spec) — does not affect decision", async () => {
    const layer = SessionStateTest()
    const d = await Effect.runPromise(
      handleStop(stop("sid-6", "the assistant said hello")).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
  })

  test("state-driven verification gate does not depend on doc-derived stop_hook_active payload semantics", async () => {
    const layer = SessionStateTest(
      new Map([
        [
          "sid-7",
          {
            ...EMPTY_SESSION_STATE,
            files_changed: ["/repo/a.ts"],
            verification_status: "none" as const,
          },
        ],
      ]),
    )

    const program = Effect.gen(function* () {
      const first = yield* handleStop(
        {
          ...stop("sid-7"),
          stop_hook_active: true,
        } as ReturnType<typeof stop> & { stop_hook_active: boolean },
      )
      const state = yield* SessionState
      const afterFirst = yield* state.get("sid-7")
      const second = yield* handleStop(
        {
          ...stop("sid-7"),
          stop_hook_active: false,
        } as ReturnType<typeof stop> & { stop_hook_active: boolean },
      )
      return { first, afterFirst, second }
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect((result.first as { decision?: string }).decision).toBe("block")
    expect(result.afterFirst.stop_blocked_once).toBe(false)
    expect((result.second as { decision?: string }).decision).toBe("block")
  })

  test("after source URLs are recorded, missing verification still blocks later Stop", async () => {
    const layer = SessionStateTest(
      new Map([
        [
          "sid-source-then-verify",
          {
            ...EMPTY_SESSION_STATE,
            requires_web_sources: true,
            files_changed: ["/repo/dashboard.html"],
            verification_status: "none" as const,
          },
        ],
      ]),
    )
    const program = Effect.gen(function* () {
      const first = yield* handleStop(stop("sid-source-then-verify"))
      const state = yield* SessionState
      yield* state.append(
        "sid-source-then-verify",
        "source_urls",
        "https://example.com/source",
      )
      const second = yield* handleStop(stop("sid-source-then-verify"))
      return { first, second }
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect((result.first as { decision?: string; reason?: string }).reason ?? "").toMatch(
      /source ledger/i,
    )
    const second = result.second as { decision?: string; reason?: string }
    expect(second.decision).toBe("block")
    expect(second.reason ?? "").toMatch(/verification command/i)
    expect(second.reason ?? "").not.toMatch(/source ledger/i)
  })

  test("blocks complete engaged ISA when classifier telemetry mismatches session route", async () => {
    const root = mkdtempSync(join(tmpdir(), "stop-isa-telemetry-"))
    try {
      const isaPath = join(root, ".claude-hooks", "work", "sid-telemetry", "ISA.md")
      mkdirSync(join(root, ".claude-hooks", "work", "sid-telemetry"), { recursive: true })
      writeFileSync(
        isaPath,
        [
          "---",
          "effort: advanced",
          "phase: complete",
          "classifier_mode: NATIVE",
          "classifier_tier: E2",
          "classifier_reason: stale route",
          "---",
          "",
          "## Problem",
          "x",
          "## Vision",
          "x",
          "## Out of Scope",
          "x",
          "## Constraints",
          "x",
          "## Goal",
          "x",
          "## Criteria",
          "- [x] ISC-1",
          "## Features",
          "x",
          "## Test Strategy",
          "x",
          "## Verification",
          "- ISC-1: done",
        ].join("\n"),
      )
      const layer = SessionStateTest(
        new Map([
          [
            "sid-telemetry",
            {
              ...EMPTY_SESSION_STATE,
              engagement_required: true,
              session_root: root,
              expected_isa_path: ".claude-hooks/work/sid-telemetry/ISA.md",
              expected_isa_path_absolute: isaPath,
              last_mode: "ALGORITHM",
              last_tier: 3,
            },
          ],
        ]),
      )
      const d = await Effect.runPromise(
        handleStop(stop("sid-telemetry")).pipe(Effect.provide(layer)),
      )
      const out = d as { decision?: string; reason?: string }
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("classifier telemetry")
      expect(out.reason ?? "").toContain("classifier_mode")
      expect(out.reason ?? "").toContain("classifier_tier")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // D2 — verify-gate "no rule matched" block reason carries diagnostics.
  test("D2: no-verify-rule block reason includes changed paths and a YAML stanza", async () => {
    // EP P2 #9 update: paths chosen to NOT match this repo's
    // .claude-hooks/verify-map.yaml rules (which cover src/**/*.ts,
    // test/**/*.ts, .claude-hooks/work/**). Pre-fix `**` was treated
    // naively so the test could use src/foo.ts and still hit the
    // "no rule" branch by coincidence. Post-fix `**` correctly
    // matches zero-or-more path segments, so we use paths under
    // a directory none of those rules cover.
    const layer = SessionStateTest(
      new Map([
        [
          "sid-d2",
          {
            ...EMPTY_SESSION_STATE,
            files_changed: [
              "uncovered/foo.md",
              "uncovered/bar.md",
              "uncovered/baz.md",
              "uncovered/qux.md",
            ],
            verification_status: "none" as const,
          },
        ],
      ]),
    )
    const d = await Effect.runPromise(
      handleStop(stop("sid-d2")).pipe(Effect.provide(layer)),
    )
    const out = d as { decision?: string; reason?: string }
    expect(out.decision).toBe("block")
    const reason = out.reason ?? ""
    expect(reason).toContain("verify-map.yaml")
    expect(reason).toContain("uncovered/foo.md")
    // Should also surface the templated rules: block.
    expect(reason).toContain("rules:")
    expect(reason).toContain("source:")
    expect(reason).toContain("command:")
    // +N more annotation when sample is truncated.
    expect(reason).toContain("+1 more")
  })

  // D3 — regenerate skip records a session-state marker for next prompt.
  test("D3: regenerate rules skipped for budget are recorded in session state", async () => {
    const root = mkdtempSync(join(tmpdir(), "stop-d3-"))
    try {
      mkdirSync(join(root, ".claude-hooks"), { recursive: true })
      // Two rules whose source matches changed files; we will force a skip
      // by setting the file mtime such that no time remains. Easier: rely
      // on the budget by claiming an enormous file change... Actually the
      // budget is wall-clock; we can't easily exceed it in a unit test.
      // Instead, monkey-patch via a rule whose source matches a changed
      // file and verify the happy/no-skip path leaves the marker empty.
      // Then add a second test that drives skip via a budget edge using
      // Date.now patching is out of scope. We test the persistence side:
      // when there ARE matched rules but no skip happens, marker stays empty.
      writeFileSync(
        join(root, ".claude-hooks", "regenerate.yaml"),
        [
          "rules:",
          "  - source: src/foo.ts",
          "    derived: docs/foo.md",
          "    command: ['true']",
        ].join("\n"),
      )
      const layer = SessionStateTest(
        new Map([
          [
            "sid-d3",
            {
              ...EMPTY_SESSION_STATE,
              files_changed: [join(root, "src/foo.ts")],
              verification_status: "passed" as const,
              // PR: verify-watermark — pre-seed the watermark so the
              // verify gate skips the rerun and the regenerate phase
              // is reached.
              verification_files: [join(root, "src/foo.ts")],
              session_root: root,
            },
          ],
        ]),
      )
      const program = Effect.gen(function* () {
        const before = Date.now
        // Force "no time remaining" by patching Date.now after first read.
        let calls = 0
        Date.now = () => {
          calls += 1
          return calls === 1 ? 0 : 1_000_000_000
        }
        try {
          yield* handleStop({
            ...stop("sid-d3"),
            cwd: root,
          } as ReturnType<typeof stop> & { cwd: string })
        } finally {
          Date.now = before
        }
        const s = yield* SessionState
        return yield* s.get("sid-d3")
      })
      const after = await Effect.runPromise(program.pipe(Effect.provide(layer)))
      expect(after.regenerate_skipped).toContain("docs/foo.md")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // D5 — optional whitelist file extends inspection-only engagement.
  test("D5: safe whitelist entries extend isPreIsaInspectionCommand; destructive entries are rejected at load", async () => {
    const root = mkdtempSync(join(tmpdir(), "stop-d5-"))
    try {
      mkdirSync(join(root, ".claude-hooks"), { recursive: true })
      writeFileSync(
        join(root, ".claude-hooks", "inspection-whitelist.yaml"),
        [
          "commands:",
          '  - "ls"',
          '  - "git log"',
          '  - "rm -rf /"',
          '  - "echo hi > /etc/passwd"',
        ].join("\n"),
      )
      const layer = SessionStateTest(
        new Map([
          [
            "sid-d5",
            {
              ...EMPTY_SESSION_STATE,
              engagement_required: true,
              last_tier: 3,
              session_root: root,
              expected_isa_path: ".claude-hooks/work/sid-d5/ISA.md",
              // Inspection-only: no files_changed; commands_run uses
              // user-whitelisted entries. Without D5, this would block
              // ("ALGORITHM E3 run is finishing without an ISA"). With
              // D5, the inspection-only gate should clear it.
              files_read: ["README.md"],
              commands_run: ["ls", "git log --oneline"],
            },
          ],
        ]),
      )
      const d = await Effect.runPromise(
        handleStop({
          ...stop("sid-d5"),
          cwd: root,
        } as ReturnType<typeof stop> & { cwd: string }).pipe(
          Effect.provide(layer),
        ),
      )
      // Inspection-only should NOT block on missing ISA.
      expect(d).toEqual({})
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("D5: destructive whitelist entries are rejected by the loader", async () => {
    const { loadInspectionWhitelist, isSafeInspectionEntry } = await import(
      "../../src/policies/inspection-whitelist.ts"
    )
    const root = mkdtempSync(join(tmpdir(), "stop-d5-load-"))
    try {
      mkdirSync(join(root, ".claude-hooks"), { recursive: true })
      writeFileSync(
        join(root, ".claude-hooks", "inspection-whitelist.yaml"),
        [
          "commands:",
          '  - "ls"',
          '  - "rm -rf /"',
          '  - "git status"',
          '  - "cat secrets > /tmp/out"',
          '  - "curl http://evil"',
          '  - "ls && rm x"',
        ].join("\n"),
      )
      const loaded = loadInspectionWhitelist(root)
      expect(loaded).toContain("ls")
      expect(loaded).toContain("git status")
      expect(loaded).not.toContain("rm -rf /")
      expect(loaded.some((c) => c.includes("rm"))).toBe(false)
      expect(loaded.some((c) => c.includes(">"))).toBe(false)
      expect(loaded.some((c) => c.includes("curl"))).toBe(false)
      expect(isSafeInspectionEntry("rm -rf /")).toBe(false)
      expect(isSafeInspectionEntry("ls")).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
