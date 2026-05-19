import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleUserPromptSubmit } from "../../src/events/prompt-router.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import {
  EMPTY_SESSION_STATE,
  SessionStateTest,
} from "../../src/services/session-state.ts"
import {
  WORKFLOW_TAGS,
  type WorkflowTag,
  classifyPrompt,
} from "../../src/policies/workflow-classifier.ts"
import { ClaudeSubprocessTest } from "../../src/services/claude-subprocess.ts"
import { InferenceTest, FAIL_SAFE } from "../../src/services/inference.ts"
import { ClassifierTelemetryTest } from "../../src/services/classifier-telemetry.ts"
import { CommandRunnerTest } from "../../src/services/command-runner.ts"
import { safeResolvePath } from "../../src/services/path-resolution.ts"

const inferenceLayer = InferenceTest(() => ({
  ...FAIL_SAFE,
  reason: "test default → ALGORITHM E3",
  latencyMs: 0,
}))
const subprocLayer = ClaudeSubprocessTest()

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const samplePromptForTag = (tag: WorkflowTag): string => {
  switch (tag) {
    case "coding.fix": return "Fix the bug"
    case "coding.feature": return "Implement a new feature"
    case "coding.refactor": return "Refactor this module"
    case "coding.review": return "Review this PR"
    case "coding.test": return "Add unit tests"
    case "coding.perf": return "Optimize performance of this query"
    case "coding.security": return "Audit for security vulnerabilities"
    case "research.web": return "Search the web for best practices"
    case "research.repo": return "Where in the codebase is this handled?"
    case "research.synthesis": return "Compare the trade-offs"
    case "writing.doc": return "Write the README"
    case "ops.git": return "Squash commits and rebase"
    case "ops.deploy": return "Deploy to production"
    case "ops.migration": return "Run the migration"
    case "unknown": return "asdf qwer zxcv"
  }
}

describe("handleUserPromptSubmit", () => {
  for (const tag of WORKFLOW_TAGS) {
    test(`classifies prompt for ${tag}`, async () => {
      const payload = decode({
        _tag: "UserPromptSubmit",
        session_id: "s",
        hook_event_name: "UserPromptSubmit",
        prompt: samplePromptForTag(tag),
      })
      const d = await Effect.runPromise(
        handleUserPromptSubmit(payload).pipe(
          Effect.provide(SessionStateTest()),
          Effect.provide(inferenceLayer),
          Effect.provide(subprocLayer),
          Effect.provide(ClassifierTelemetryTest().layer),
          Effect.provide(CommandRunnerTest()),
        ),
      )
      const out = d as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string }
      }
      expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
      expect(out.hookSpecificOutput.additionalContext).toContain(`Detected workflow: ${tag}`)
      expect(out.hookSpecificOutput.additionalContext).toContain(
        classifyPrompt(samplePromptForTag(tag)).playbook,
      )
    })
  }

  test("ALGORITHM tier ≥ 3 → emits ISA engagement directive with deterministic path", async () => {
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "abc-123",
      hook_event_name: "UserPromptSubmit",
      prompt: "implement a log-analysis CLI in TypeScript with three subcommands",
    })
    const d = await Effect.runPromise(
      handleUserPromptSubmit(payload).pipe(
        Effect.provide(SessionStateTest()),
        Effect.provide(inferenceLayer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
        Effect.provide(CommandRunnerTest()),
      ),
    )
    const ctx = (
      d as { hookSpecificOutput: { additionalContext: string } }
    ).hookSpecificOutput.additionalContext
    expect(ctx).toContain("ENGAGE: ALGORITHM_ENGAGEMENT_REQUIRED=true")
    expect(ctx).toContain("ISA_PATH=.claude-hooks/work/abc-123/ISA.md")
    expect(ctx).toContain("FIRST ACTION NOW")
    expect(ctx).toContain("Do not probe with implementation tools")
    expect(ctx).toContain("`classifier_mode: ALGORITHM`")
    expect(ctx).toContain("`classifier_tier: E3`")
    expect(ctx).toContain("`classifier_reason: test default → ALGORITHM E3`")
    expect(ctx).toContain("Required sections for E3:")
    expect(ctx).toContain("Use exact H2 headings")
    expect(ctx).toContain("one bulk write/edit")
    expect(ctx).toContain("Problem")
    expect(ctx).toContain("Out of Scope")
    expect(ctx).toContain("Test Strategy")
    expect(ctx).toContain("absence is treated as failure")
  })

  test("repo investigation workflow nudges toward Agent delegation", async () => {
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "agent-nudge",
      hook_event_name: "UserPromptSubmit",
      prompt: "Where in the codebase is the worker enforcement gate defined?",
    })
    const d = await Effect.runPromise(
      handleUserPromptSubmit(payload).pipe(
        Effect.provide(SessionStateTest()),
        Effect.provide(inferenceLayer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
        Effect.provide(CommandRunnerTest()),
      ),
    )
    const ctx = (
      d as { hookSpecificOutput: { additionalContext: string } }
    ).hookSpecificOutput.additionalContext
    expect(ctx).toContain("Detected workflow: research.repo")
    expect(ctx).toContain("Prefer Agent delegation for this turn.")
  })

  test("existing expected ISA → directive says to update without phase demotion", async () => {
    const root = mkdtempSync(join(tmpdir(), "prompt-router-isa-"))
    try {
      const isaPath = join(root, ".claude-hooks", "work", "abc-existing", "ISA.md")
      mkdirSync(join(root, ".claude-hooks", "work", "abc-existing"), { recursive: true })
      writeFileSync(
        isaPath,
        "---\neffort: advanced\nphase: complete\n---\n\n## Goal\nDone\n## Criteria\n- ISC-1\n## Verification\n- ISC-1: done\n",
      )
      const payload = decode({
        _tag: "UserPromptSubmit",
        session_id: "abc-existing",
        hook_event_name: "UserPromptSubmit",
        cwd: root,
        prompt: "implement a log-analysis CLI in TypeScript with three subcommands",
      })
      const d = await Effect.runPromise(
        handleUserPromptSubmit(payload).pipe(
          Effect.provide(SessionStateTest()),
          Effect.provide(inferenceLayer),
          Effect.provide(subprocLayer),
          Effect.provide(ClassifierTelemetryTest().layer),
          Effect.provide(CommandRunnerTest()),
        ),
      )
      const ctx = (
        d as { hookSpecificOutput: { additionalContext: string } }
      ).hookSpecificOutput.additionalContext
      expect(ctx).toContain("UPDATE EXISTING ISA")
      expect(ctx).toContain(isaPath)
      expect(ctx).toContain("do not reset `phase: complete`")
      expect(ctx).not.toContain("FIRST ACTION NOW")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("ALGORITHM E4 → directive lists all twelve sections", async () => {
    const e4Layer = InferenceTest(() => ({
      mode: "ALGORITHM",
      tier: 4,
      reason: "test e4",
      source: "classifier",
      latencyMs: 0,
    }))
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "deep-1",
      hook_event_name: "UserPromptSubmit",
      prompt: "rearchitect the dispatcher to support sharded handlers",
    })
    const d = await Effect.runPromise(
      handleUserPromptSubmit(payload).pipe(
        Effect.provide(SessionStateTest()),
        Effect.provide(e4Layer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
        Effect.provide(CommandRunnerTest()),
      ),
    )
    const ctx = (
      d as { hookSpecificOutput: { additionalContext: string } }
    ).hookSpecificOutput.additionalContext
    expect(ctx).toContain("Required sections for E4:")
    for (const s of [
      "Problem",
      "Vision",
      "Out of Scope",
      "Principles",
      "Constraints",
      "Goal",
      "Criteria",
      "Test Strategy",
      "Features",
      "Decisions",
      "Changelog",
      "Verification",
    ]) {
      expect(ctx).toContain(s)
    }
  })

  test("ALGORITHM tier ≥ 3 → writes engagement bookkeeping to SessionState", async () => {
    const { SessionState } = await import(
      "../../src/services/session-state.ts"
    )
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "track-me",
      hook_event_name: "UserPromptSubmit",
      prompt: "build the thing",
    })
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleUserPromptSubmit(payload)
        const s = yield* SessionState
        return yield* s.get("track-me")
      }).pipe(
        Effect.provide(SessionStateTest()),
        Effect.provide(inferenceLayer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
        Effect.provide(CommandRunnerTest()),
      ),
    )
    expect(record.engagement_required).toBe(true)
    expect(record.last_mode).toBe("ALGORITHM")
    expect(record.last_tier).toBe(3)
    expect(record.expected_isa_path).toBe(
      ".claude-hooks/work/track-me/ISA.md",
    )
  })

  test("MINIMAL → engagement_required stays false in SessionState", async () => {
    const { SessionState } = await import(
      "../../src/services/session-state.ts"
    )
    const minimalLayer = InferenceTest(() => ({
      mode: "MINIMAL",
      tier: null,
      reason: "test minimal",
      source: "classifier",
      latencyMs: 0,
    }))
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "untracked",
      hook_event_name: "UserPromptSubmit",
      prompt: "thanks",
    })
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleUserPromptSubmit(payload)
        const s = yield* SessionState
        return yield* s.get("untracked")
      }).pipe(
        Effect.provide(SessionStateTest()),
        Effect.provide(minimalLayer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
        Effect.provide(CommandRunnerTest()),
      ),
    )
    expect(record.engagement_required).toBe(false)
    expect(record.last_mode).toBe("MINIMAL")
    expect(record.expected_isa_path).toBe(null)
  })

  test("MINIMAL follow-up does not clear an active ALGORITHM engagement", async () => {
    const { SessionState } = await import(
      "../../src/services/session-state.ts"
    )
    const minimalLayer = InferenceTest(() => ({
      mode: "MINIMAL",
      tier: null,
      reason: "test minimal",
      source: "classifier",
      latencyMs: 0,
    }))
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "active-engagement",
      hook_event_name: "UserPromptSubmit",
      prompt: "ok continue",
    })
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleUserPromptSubmit(payload)
        const s = yield* SessionState
        return yield* s.get("active-engagement")
      }).pipe(
        Effect.provide(
          SessionStateTest(
            new Map([
              [
                "active-engagement",
                {
                  ...EMPTY_SESSION_STATE,
                  engagement_required: true,
                  last_mode: "ALGORITHM",
                  last_tier: 3,
                  expected_isa_path:
                    ".claude-hooks/work/active-engagement/ISA.md",
                  expected_isa_path_absolute:
                    "/repo/.claude-hooks/work/active-engagement/ISA.md",
                  session_root: "/repo",
                },
              ],
            ]),
          ),
        ),
        Effect.provide(minimalLayer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
        Effect.provide(CommandRunnerTest()),
      ),
    )
    expect(record.engagement_required).toBe(true)
    expect(record.last_mode).toBe("ALGORITHM")
    expect(record.last_tier).toBe(3)
    expect(record.expected_isa_path).toBe(
      ".claude-hooks/work/active-engagement/ISA.md",
    )
  })

  test("repeated engagement repairs corrupt expected_isa_path_absolute", async () => {
    const { SessionState } = await import(
      "../../src/services/session-state.ts"
    )
    const root = mkdtempSync(join(tmpdir(), "chts-router-abs-"))
    try {
      const payload = decode({
        _tag: "UserPromptSubmit",
        session_id: "repair-abs",
        hook_event_name: "UserPromptSubmit",
        cwd: root,
        prompt: "build the thing",
      })
      const record = await Effect.runPromise(
        Effect.gen(function* () {
          yield* handleUserPromptSubmit(payload)
          const s = yield* SessionState
          return yield* s.get("repair-abs")
        }).pipe(
          Effect.provide(
            SessionStateTest(
              new Map([
                [
                  "repair-abs",
                  {
                    ...EMPTY_SESSION_STATE,
                    engagement_required: true,
                    last_mode: "ALGORITHM",
                    last_tier: 3,
                    expected_isa_path: ".claude-hooks/work/repair-abs/ISA.md",
                    expected_isa_path_absolute:
                      "/tmp/outside/.claude-hooks/work/repair-abs/ISA.md",
                    session_root: root,
                  },
                ],
              ]),
            ),
          ),
          Effect.provide(inferenceLayer),
          Effect.provide(subprocLayer),
          Effect.provide(ClassifierTelemetryTest().layer),
          Effect.provide(CommandRunnerTest()),
        ),
      )
      expect(record.expected_isa_path_absolute).toBe(
        safeResolvePath(root, ".claude-hooks/work/repair-abs/ISA.md"),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("MINIMAL → no ISA engagement directive", async () => {
    const minimalLayer = InferenceTest(() => ({
      mode: "MINIMAL",
      tier: null,
      reason: "test minimal",
      source: "classifier",
      latencyMs: 0,
    }))
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "s",
      hook_event_name: "UserPromptSubmit",
      prompt: "thanks",
    })
    const d = await Effect.runPromise(
      handleUserPromptSubmit(payload).pipe(
        Effect.provide(SessionStateTest()),
        Effect.provide(minimalLayer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
        Effect.provide(CommandRunnerTest()),
      ),
    )
    const ctx = (
      d as { hookSpecificOutput: { additionalContext: string } }
    ).hookSpecificOutput.additionalContext
    expect(ctx).not.toContain("ENGAGE")
  })

  test("ALGORITHM tier 2 → no ISA engagement directive", async () => {
    const tier2Layer = InferenceTest(() => ({
      mode: "ALGORITHM",
      tier: 2,
      reason: "test tier 2",
      source: "classifier",
      latencyMs: 0,
    }))
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "s",
      hook_event_name: "UserPromptSubmit",
      prompt: "rename foo to bar in this file",
    })
    const d = await Effect.runPromise(
      handleUserPromptSubmit(payload).pipe(
        Effect.provide(SessionStateTest()),
        Effect.provide(tier2Layer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
        Effect.provide(CommandRunnerTest()),
      ),
    )
    const ctx = (
      d as { hookSpecificOutput: { additionalContext: string } }
    ).hookSpecificOutput.additionalContext
    expect(ctx).not.toContain("ENGAGE")
  })

  test("persists requires_web_sources=true for an explicit web-research prompt", async () => {
    const { SessionState } = await import(
      "../../src/services/session-state.ts"
    )
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "needs-urls",
      hook_event_name: "UserPromptSubmit",
      prompt: "Search the web for the latest React best practices",
    })
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleUserPromptSubmit(payload)
        const s = yield* SessionState
        return yield* s.get("needs-urls")
      }).pipe(
        Effect.provide(SessionStateTest()),
        Effect.provide(inferenceLayer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
        Effect.provide(CommandRunnerTest()),
      ),
    )
    expect(record.requires_web_sources).toBe(true)
    expect(record.last_workflow).toBe("research.web")
  })

  test("persists requires_web_sources=true for a source-backed feature build", async () => {
    const { SessionState } = await import(
      "../../src/services/session-state.ts"
    )
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "solar-dashboard",
      hook_event_name: "UserPromptSubmit",
      prompt: `Create a single-page HTML dashboard for underwriting a small solar-installation business.

Pull real current benchmark data where useful, such as average residential solar install cost per watt,
battery storage attach-rate or cost ranges, current federal tax credit, and recent residential
electricity price trends. Cite the sources in the page footer.`,
    })
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleUserPromptSubmit(payload)
        const s = yield* SessionState
        return yield* s.get("solar-dashboard")
      }).pipe(
        Effect.provide(SessionStateTest()),
        Effect.provide(inferenceLayer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
        Effect.provide(CommandRunnerTest()),
      ),
    )
    expect(record.last_workflow).toBe("coding.feature")
    expect(record.requires_web_sources).toBe(true)
  })

  test("resets stale source URLs when a new source-backed prompt starts", async () => {
    const { SessionState } = await import(
      "../../src/services/session-state.ts"
    )
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "fresh-source-task",
      hook_event_name: "UserPromptSubmit",
      prompt: "Create a single-page HTML dashboard and pull real current benchmark data. Cite the sources.",
    })
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleUserPromptSubmit(payload)
        const s = yield* SessionState
        return yield* s.get("fresh-source-task")
      }).pipe(
        Effect.provide(
          SessionStateTest(
            new Map([
              [
                "fresh-source-task",
                {
                  ...EMPTY_SESSION_STATE,
                  source_urls: ["https://example.com/stale"],
                },
              ],
            ]),
          ),
        ),
        Effect.provide(inferenceLayer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
        Effect.provide(CommandRunnerTest()),
      ),
    )
    expect(record.requires_web_sources).toBe(true)
    expect(record.source_urls).toEqual([])
  })

  test("MINIMAL follow-up does not clear an unsatisfied source obligation", async () => {
    const { SessionState } = await import(
      "../../src/services/session-state.ts"
    )
    const minimalLayer = InferenceTest(() => ({
      mode: "MINIMAL",
      tier: null,
      reason: "test minimal",
      source: "classifier",
      latencyMs: 0,
    }))
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "source-follow-up",
      hook_event_name: "UserPromptSubmit",
      prompt: "ok continue",
    })
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleUserPromptSubmit(payload)
        const s = yield* SessionState
        return yield* s.get("source-follow-up")
      }).pipe(
        Effect.provide(
          SessionStateTest(
            new Map([
              [
                "source-follow-up",
                {
                  ...EMPTY_SESSION_STATE,
                  requires_web_sources: true,
                  source_urls: [],
                },
              ],
            ]),
          ),
        ),
        Effect.provide(minimalLayer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
        Effect.provide(CommandRunnerTest()),
      ),
    )
    expect(record.requires_web_sources).toBe(true)
    expect(record.source_urls).toEqual([])
  })

  test("MINIMAL follow-up may clear a satisfied source obligation", async () => {
    const { SessionState } = await import(
      "../../src/services/session-state.ts"
    )
    const minimalLayer = InferenceTest(() => ({
      mode: "MINIMAL",
      tier: null,
      reason: "test minimal",
      source: "classifier",
      latencyMs: 0,
    }))
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "satisfied-source-follow-up",
      hook_event_name: "UserPromptSubmit",
      prompt: "ok continue",
    })
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleUserPromptSubmit(payload)
        const s = yield* SessionState
        return yield* s.get("satisfied-source-follow-up")
      }).pipe(
        Effect.provide(
          SessionStateTest(
            new Map([
              [
                "satisfied-source-follow-up",
                {
                  ...EMPTY_SESSION_STATE,
                  requires_web_sources: true,
                  source_urls: ["https://example.com/source"],
                },
              ],
            ]),
          ),
        ),
        Effect.provide(minimalLayer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
        Effect.provide(CommandRunnerTest()),
      ),
    )
    expect(record.requires_web_sources).toBe(false)
    expect(record.source_urls).toEqual(["https://example.com/source"])
  })

  test("persists requires_web_sources=false for a loose research.web priming match", async () => {
    // This is the decoupling contract: the priming tag is `research.web`
    // (because "look up" matches the priming regex) but the STRICT
    // `requiresWebSources` predicate does NOT fire for "look up my notes"
    // — there's no `search the web`, `cite authoritative sources`, etc.
    // Old behavior would have blocked Stop on the loose priming match;
    // the new contract requires `requires_web_sources=false` here so the
    // Stop gate doesn't fire.
    const { SessionState } = await import(
      "../../src/services/session-state.ts"
    )
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "loose-research",
      hook_event_name: "UserPromptSubmit",
      prompt: "look up my notes from yesterday",
    })
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleUserPromptSubmit(payload)
        const s = yield* SessionState
        return yield* s.get("loose-research")
      }).pipe(
        Effect.provide(SessionStateTest()),
        Effect.provide(inferenceLayer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
        Effect.provide(CommandRunnerTest()),
      ),
    )
    // Priming tag is the loose research.web (via "look up"), but the
    // strict gate signal stays false — this is the decoupling.
    expect(record.last_workflow).toBe("research.web")
    expect(record.requires_web_sources).toBe(false)
  })

  test("US-4: coding workflow + WEAK pattern in prompt → requires_web_sources=false (workflow scoping suppresses)", async () => {
    // 'current best practices for error handling' is the dominant false-
    // positive class motivating US-4. classifyPrompt routes it to a
    // coding.* workflow (coding.fix here), which the new
    // requiresWebSources signature suppresses to false despite the WEAK
    // pattern match. The end-to-end contract: prompt → router → session
    // state shows requires_web_sources=false.
    const { SessionState } = await import(
      "../../src/services/session-state.ts"
    )
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "us4-coding-weak",
      hook_event_name: "UserPromptSubmit",
      prompt: "current best practices for error handling",
    })
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleUserPromptSubmit(payload)
        const s = yield* SessionState
        return yield* s.get("us4-coding-weak")
      }).pipe(
        Effect.provide(SessionStateTest()),
        Effect.provide(inferenceLayer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
        Effect.provide(CommandRunnerTest()),
      ),
    )
    // Workflow classifier tags this as coding.fix (error handling).
    expect(record.last_workflow).toBe("coding.fix")
    // US-4: workflow-scoping suppresses the WEAK pattern in coding workflows.
    expect(record.requires_web_sources).toBe(false)
  })

  test("US-4: coding workflow + STRONG pattern still forces requires_web_sources=true (belt-and-suspenders)", async () => {
    // A coding task that EXPLICITLY invokes web research still triggers
    // the ledger — STRONG patterns are workflow-agnostic.
    const { SessionState } = await import(
      "../../src/services/session-state.ts"
    )
    const payload = decode({
      _tag: "UserPromptSubmit",
      session_id: "us4-coding-strong",
      hook_event_name: "UserPromptSubmit",
      prompt: "build a feature that uses cite the sources at the bottom",
    })
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleUserPromptSubmit(payload)
        const s = yield* SessionState
        return yield* s.get("us4-coding-strong")
      }).pipe(
        Effect.provide(SessionStateTest()),
        Effect.provide(inferenceLayer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
        Effect.provide(CommandRunnerTest()),
      ),
    )
    expect(record.last_workflow).toBe("coding.feature")
    expect(record.requires_web_sources).toBe(true)
  })

  test("non-UserPromptSubmit payload → NO_DECISION", async () => {
    const payload = decode({
      _tag: "Stop",
      session_id: "s",
      hook_event_name: "Stop",
    })
    const d = await Effect.runPromise(
      handleUserPromptSubmit(payload).pipe(
        Effect.provide(SessionStateTest()),
        Effect.provide(inferenceLayer),
        Effect.provide(subprocLayer),
        Effect.provide(ClassifierTelemetryTest().layer),
        Effect.provide(CommandRunnerTest()),
      ),
    )
    expect(d).toEqual({})
  })
})
