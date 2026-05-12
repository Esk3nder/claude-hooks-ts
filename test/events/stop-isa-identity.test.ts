/**
 * P1.1 — Stop absence gate must scope ISA lookup to the session's expected ISA.
 *
 * A stale foreign-slug ISA from a previous task must NOT satisfy the current
 * engagement. The Stop absence gate, when the session's expected ISA path is
 * missing, must block — regardless of any other ISA lying under session_root.
 *
 * FIXES: ISA-identity must be session-scoped.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleStop } from "../../src/events/stop-definition-of-done.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import {
  SessionStateTest,
  EMPTY_SESSION_STATE,
  type SessionStateRecord,
} from "../../src/services/session-state.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const stage = (): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "chts-stop-identity-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const writeForeignTaskIsa = (root: string, slug: string): void => {
  const dir = join(root, ".claude-hooks", "work", slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "ISA.md"),
    `---
task: foreign
slug: ${slug}
effort: advanced
phase: observe
---

## Goal
foreign

## Criteria
- [ ] ISC-1: foreign artifact, not ours
`,
    "utf-8",
  )
}

const runStop = async (
  cwd: string,
  initial: Partial<SessionStateRecord>,
): Promise<{ decision?: string; reason?: string }> => {
  const sessionId = "test-stop-identity"
  const seed = new Map([[sessionId, { ...EMPTY_SESSION_STATE, ...initial }]])
  const payload = decode({
    _tag: "Stop",
    session_id: sessionId,
    hook_event_name: "Stop",
    cwd,
  })
  const decision = await Effect.runPromise(
    handleStop(payload).pipe(Effect.provide(SessionStateTest(seed))),
  )
  return decision as { decision?: string; reason?: string }
}

describe("Stop absence gate — session-scoped ISA identity", () => {
  test("foreign-slug ISA must NOT satisfy current engagement (expected ISA absent → block)", async () => {
    const { root, cleanup } = stage()
    try {
      // Foreign-slug ISA from a different task exists under session_root.
      writeForeignTaskIsa(root, "old-slug")
      // Current session expects its own ISA which is NOT on disk.
      const expectedRel = ".claude-hooks/work/current-slug/ISA.md"
      const expectedAbs = join(root, expectedRel)
      const out = await runStop(root, {
        engagement_required: true,
        last_mode: "ALGORITHM",
        last_tier: 3,
        expected_isa_path: expectedRel,
        expected_isa_path_absolute: expectedAbs,
        session_root: root,
      })
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("current-slug")
    } finally {
      cleanup()
    }
  })
})
