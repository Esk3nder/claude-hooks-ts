import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleStop } from "../../src/events/stop-definition-of-done.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import {
  EMPTY_SESSION_STATE,
  SessionStateTest,
  type SessionStateRecord,
} from "../../src/services/session-state.ts"
import { RuntimeConfigTest } from "../../src/services/runtime-config.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const SID = "context-budget"

const completeIsa = (handoff = ""): string =>
  [
    "---",
    "effort: advanced",
    "phase: complete",
    "classifier_mode: ALGORITHM",
    "classifier_tier: E3",
    "classifier_reason: context budget fixture",
    "---",
    "",
    "## Problem",
    "x",
    "",
    "## Vision",
    "x",
    "",
    "## Out of Scope",
    "x",
    "",
    "## Constraints",
    "x",
    "",
    "## Goal",
    "x",
    "",
    "## Criteria",
    "- [x] ISC-1: keep state recoverable before compaction",
    "",
    "## Test Strategy",
    "ISC-1 | unit | context budget | no | stop-context-budget",
    "",
    "## Features",
    "context budget gate | ISC-1 | none | yes",
    "",
    "## Verification",
    "- ISC-1: fixture passed",
    ...(handoff.length === 0 ? [] : ["", "## Handoff", handoff]),
  ].join("\n")

const stage = (isa: string): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "chts-context-budget-"))
  writeFileSync(join(root, "ISA.md"), isa, "utf-8")
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const stopAt = (cwd: string, contextPercent: number) =>
  decode({
    _tag: "Stop",
    session_id: SID,
    hook_event_name: "Stop",
    cwd,
    metadata: { context_percent: contextPercent },
  })

const stateFor = (root: string): Map<string, SessionStateRecord> =>
  new Map([
    [
      SID,
      {
        ...EMPTY_SESSION_STATE,
        engagement_required: true,
        last_mode: "ALGORITHM",
        last_tier: 3,
        session_root: root,
      },
    ],
  ])

const runStop = async (
  root: string,
  contextPercent: number,
  threshold = 85,
): Promise<{ decision?: string; reason?: string }> => {
  const layer = Layer.mergeAll(
    SessionStateTest(stateFor(root)),
    RuntimeConfigTest({ contextBudgetThresholdPct: threshold }),
  )
  return Effect.runPromise(
    handleStop(stopAt(root, contextPercent)).pipe(Effect.provide(layer)),
  ) as Promise<{ decision?: string; reason?: string }>
}

const runStopWithRecord = async (
  root: string,
  record: SessionStateRecord,
  contextPercent: number,
  threshold = 85,
): Promise<{ decision?: string; reason?: string }> => {
  const layer = Layer.mergeAll(
    SessionStateTest(new Map([[SID, record]])),
    RuntimeConfigTest({ contextBudgetThresholdPct: threshold }),
  )
  return Effect.runPromise(
    handleStop(stopAt(root, contextPercent)).pipe(Effect.provide(layer)),
  ) as Promise<{ decision?: string; reason?: string }>
}

describe("handleStop context-budget gate", () => {
  test("under threshold -> no-op", async () => {
    const { root, cleanup } = stage(completeIsa())
    try {
      const out = await runStop(root, 40)
      expect(out.decision).not.toBe("block")
    } finally {
      cleanup()
    }
  })

  test("over threshold + no handoff -> block", async () => {
    const { root, cleanup } = stage(completeIsa())
    try {
      const out = await runStop(root, 90)
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("## Handoff")
    } finally {
      cleanup()
    }
  })

  test("over threshold without an active ISA -> no-op", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-context-budget-no-isa-"))
    try {
      const out = await runStopWithRecord(
        root,
        {
          ...EMPTY_SESSION_STATE,
          engagement_required: false,
          last_mode: "NATIVE",
          last_tier: null,
          session_root: root,
        },
        99,
      )
      expect(out.decision).not.toBe("block")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("threshold 0 disables the gate", async () => {
    const { root, cleanup } = stage(completeIsa())
    try {
      const out = await runStop(root, 99, 0)
      expect(out.decision).not.toBe("block")
    } finally {
      cleanup()
    }
  })

  test("over threshold + handoff -> pass", async () => {
    const handoff =
      "- Continue from ISC-1: context budget fixture is verified; next owner should run stop-context-budget tests."
    const { root, cleanup } = stage(completeIsa(handoff))
    try {
      const out = await runStop(root, 90)
      expect(out.decision).not.toBe("block")
    } finally {
      cleanup()
    }
  })
})
