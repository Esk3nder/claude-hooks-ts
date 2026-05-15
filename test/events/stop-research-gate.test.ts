import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { handleStop } from "../../src/events/stop-definition-of-done.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import {
  SessionStateTest,
  EMPTY_SESSION_STATE,
} from "../../src/services/session-state.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)
const stop = (sid: string) =>
  decode({
    _tag: "Stop",
    session_id: sid,
    hook_event_name: "Stop",
  })

/**
 * The research-mode source-ledger gate now keys off the strict
 * `requires_web_sources` boolean (set by the prompt-router from the
 * `requiresWebSources` predicate in workflow-classifier), NOT the loose
 * `last_workflow` priming tag. This guarantees a loose priming match
 * (e.g. bare "latest" in a git-sync prompt, or research.repo for a
 * codebase question) cannot turn into a Stop block.
 */
describe("handleStop (research-mode source-ledger gate)", () => {
  test("blocks when requires_web_sources=true and no source URLs", async () => {
    const layer = SessionStateTest(
      new Map([
        [
          "r1",
          {
            ...EMPTY_SESSION_STATE,
            last_workflow: "research.web",
            requires_web_sources: true,
          },
        ],
      ]),
    )
    const d = await Effect.runPromise(
      handleStop(stop("r1")).pipe(Effect.provide(layer)),
    )
    const out = d as { decision?: string; reason?: string }
    expect(out.decision).toBe("block")
    expect(out.reason ?? "").toMatch(/source ledger/i)
    expect(out.reason ?? "").toContain("Fetch or search")
    expect(out.reason ?? "").toContain("Do not satisfy this gate with a prose reconciliation alone")
  })

  test("blocks source-required coding workflows, not just research.web", async () => {
    const layer = SessionStateTest(
      new Map([
        [
          "feature-needs-sources",
          {
            ...EMPTY_SESSION_STATE,
            last_workflow: "coding.feature",
            requires_web_sources: true,
          },
        ],
      ]),
    )
    const d = await Effect.runPromise(
      handleStop(stop("feature-needs-sources")).pipe(Effect.provide(layer)),
    )
    const out = d as { decision?: string; reason?: string }
    expect(out.decision).toBe("block")
    expect(out.reason ?? "").toMatch(/source ledger/i)
  })

  test("allows when requires_web_sources=true and source URLs recorded", async () => {
    const layer = SessionStateTest(
      new Map([
        [
          "r2",
          {
            ...EMPTY_SESSION_STATE,
            last_workflow: "research.web",
            requires_web_sources: true,
            source_urls: ["https://example.com/a"],
          },
        ],
      ]),
    )
    const d = await Effect.runPromise(
      handleStop(stop("r2")).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
  })

  test("does not trigger gate for coding.* workflow", async () => {
    const layer = SessionStateTest(
      new Map([
        [
          "c1",
          {
            ...EMPTY_SESSION_STATE,
            last_workflow: "coding.fix",
          },
        ],
      ]),
    )
    const d = await Effect.runPromise(
      handleStop(stop("c1")).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
  })

  test("loop-guard: stop_blocked_once short-circuits to NoOp even in research mode", async () => {
    const layer = SessionStateTest(
      new Map([
        [
          "r3",
          {
            ...EMPTY_SESSION_STATE,
            last_workflow: "research.web",
            requires_web_sources: true,
            stop_blocked_once: true,
          },
        ],
      ]),
    )
    const d = await Effect.runPromise(
      handleStop(stop("r3")).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
  })

  // Regression pins for the priming-vs-gating split. Each of these is a
  // state shape the OLD gate (which keyed off `last_workflow.startsWith
  // ("research.")`) would have blocked on. The NEW gate must NOT block.

  test("loose research.web priming match without strict signal does NOT block", async () => {
    // Reproduces the in-session bug: "are we on the latest" was classified
    // as research.web by the loose priming regex, but requiresWebSources
    // returns false on that prompt, so the gate must not fire.
    const layer = SessionStateTest(
      new Map([
        [
          "loose",
          {
            ...EMPTY_SESSION_STATE,
            last_workflow: "research.web",
            requires_web_sources: false,
          },
        ],
      ]),
    )
    const d = await Effect.runPromise(
      handleStop(stop("loose")).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
  })

  test("research.repo workflow does NOT block on empty source URLs", async () => {
    // A codebase question ("find the function that parses JWTs") cannot
    // sensibly produce web-research URLs; the OLD gate blocked it anyway
    // via startsWith("research.").
    const layer = SessionStateTest(
      new Map([
        [
          "repo",
          {
            ...EMPTY_SESSION_STATE,
            last_workflow: "research.repo",
            requires_web_sources: false,
          },
        ],
      ]),
    )
    const d = await Effect.runPromise(
      handleStop(stop("repo")).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
  })

  test("research.synthesis workflow does NOT block on empty source URLs", async () => {
    // Comparing two approaches doesn't require external URLs unless the
    // strict predicate explicitly fires. OLD behavior blocked.
    const layer = SessionStateTest(
      new Map([
        [
          "synth",
          {
            ...EMPTY_SESSION_STATE,
            last_workflow: "research.synthesis",
            requires_web_sources: false,
          },
        ],
      ]),
    )
    const d = await Effect.runPromise(
      handleStop(stop("synth")).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
  })
})
