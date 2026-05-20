/**
 * Shared fixtures for the methodology integration suite.
 *
 * Each test in this directory pins one pillar of the
 * RPI + TDD + leveraged-workers + right-sized-ceremony promise:
 * end-to-end through the relevant handler, not through the dispatcher.
 * (The dispatcher protocol is exhaustively covered by test/dispatcher*).
 *
 * These helpers stand up a tmpdir project root + a seeded SessionState
 * record so a test can `await runHandler(...)` and assert on the
 * returned decision without re-implementing setup each time.
 */
import { Effect, Layer, Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { HookPayload } from "../../../src/schema/payloads.ts"
import {
  EMPTY_SESSION_STATE,
  SessionState,
  SessionStateTest,
  type SessionStateRecord,
} from "../../../src/services/session-state.ts"

export const decodePayload = (raw: unknown): HookPayload =>
  Schema.decodeUnknownSync(HookPayload)(raw)

export interface TmpProject {
  readonly root: string
  readonly cleanup: () => void
}

/** realpath-normalize so paths frozen into session state match the form
 * gates resolve to internally (on macOS /tmp is a symlink to /private/tmp). */
export const withTmpProject = (label: string): TmpProject => {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), `chts-method-${label}-`))
  const root = fs.realpathSync(raw)
  return {
    root,
    cleanup: () => fs.rmSync(raw, { recursive: true, force: true }),
  }
}

/** Seed an in-memory SessionState test layer with one record. */
export const seedSessionRecord = (
  sessionId: string,
  patch: Partial<SessionStateRecord> = {},
): Layer.Layer<SessionState> =>
  SessionStateTest(
    new Map([[sessionId, { ...EMPTY_SESSION_STATE, ...patch }]]),
  )

/** Standard engaged-session patch for a fixture session at the given root. */
export const engagedPatch = (
  root: string,
  sessionId: string,
  tier = 3,
): Partial<SessionStateRecord> => {
  const rel = `.claude-hooks/work/${sessionId}/ISA.md`
  return {
    engagement_required: true,
    last_mode: "ALGORITHM",
    last_tier: tier,
    expected_isa_path: rel,
    expected_isa_path_absolute: path.join(root, rel),
    session_root: root,
  }
}

/** A valid minimal E3 ISA. Used by tests that need an ISA on disk before
 * the engagement gate releases. */
export const ISA_E3_FIXTURE = `---
effort: advanced
phase: observe
classifier_mode: ALGORITHM
classifier_tier: E3
classifier_reason: methodology integration fixture
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
| isc | tool |
|---|---|
| ISC-1 | typecheck |
`

/** Write the ISA fixture to `<root>/<relIsaPath>` and return its absolute path. */
export const writeIsaFixture = (
  root: string,
  relIsaPath: string,
  body: string = ISA_E3_FIXTURE,
): string => {
  const abs = path.join(root, relIsaPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body, "utf-8")
  return abs
}

/** Run an Effect program with the minimum layer set for handler tests. */
export const runWithLayers = <A, E>(
  program: Effect.Effect<A, E, SessionState>,
  layers: Layer.Layer<SessionState>,
): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(layers)) as Effect.Effect<A, E, never>)

/** PreToolUse decisions surface as `hookSpecificOutput`. Narrow the union
 * so tests can assert on the field without TS complaining about the
 * other decision variants. Returns null when the decision is a different
 * variant (caller should fail the test in that case). */
export const preToolDecisionOutput = (
  decision: unknown,
):
  | {
      readonly hookEventName: string
      readonly permissionDecision?: "allow" | "deny" | "ask"
      readonly permissionDecisionReason?: string
      readonly updatedInput?: unknown
    }
  | null => {
  if (
    decision !== null &&
    typeof decision === "object" &&
    "hookSpecificOutput" in decision
  ) {
    const out = (decision as { hookSpecificOutput: unknown }).hookSpecificOutput
    if (out !== null && typeof out === "object") {
      return out as {
        readonly hookEventName: string
        readonly permissionDecision?: "allow" | "deny" | "ask"
        readonly permissionDecisionReason?: string
        readonly updatedInput?: unknown
      }
    }
  }
  return null
}
