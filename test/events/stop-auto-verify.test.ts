import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleStop } from "../../src/events/stop-definition-of-done.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import {
  SessionState,
  SessionStateTest,
  EMPTY_SESSION_STATE,
} from "../../src/services/session-state.ts"
import { verifyMapPathFor } from "../../src/policies/verify-map.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const stopAt = (sid: string, cwd: string) =>
  decode({
    _tag: "Stop",
    session_id: sid,
    hook_event_name: "Stop",
    cwd,
  })

const stage = (): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "chts-stopverify-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const writeVerifyMap = (root: string, contents: string): void => {
  mkdirSync(join(root, ".claude-hooks"), { recursive: true })
  writeFileSync(verifyMapPathFor(root), contents, "utf-8")
}

describe("handleStop with verify-map auto-verifier", () => {
  test("auto-verify passes → Stop allowed, verification_status=passed, tests_run appended", async () => {
    const { root, cleanup } = stage()
    try {
      writeVerifyMap(
        root,
        `rules:
  - source: src/*.ts
    command: ["true"]
    timeoutMs: 5000
`,
      )
      const layer = SessionStateTest(
        new Map([
          [
            "sid-pass",
            {
              ...EMPTY_SESSION_STATE,
              files_changed: ["src/a.ts"],
              verification_status: "none" as const,
            },
          ],
        ]),
      )
      const program = Effect.gen(function* () {
        const decision = yield* handleStop(stopAt("sid-pass", root))
        const s = yield* SessionState
        const after = yield* s.get("sid-pass")
        return { decision, after }
      })
      const { decision, after } = await Effect.runPromise(
        program.pipe(Effect.provide(layer)),
      )
      expect(decision).toEqual({})
      expect(after.verification_status).toBe("passed")
      expect(after.tests_run).toContain("true")
      expect(after.stop_blocked_once).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("absolute files_changed paths match repo-relative verify-map sources", async () => {
    const { root, cleanup } = stage()
    try {
      writeVerifyMap(
        root,
        `rules:
  - source: src/*.ts
    command: ["true"]
    timeoutMs: 5000
`,
      )
      const layer = SessionStateTest(
        new Map([
          [
            "sid-absolute-path",
            {
              ...EMPTY_SESSION_STATE,
              files_changed: [join(root, "src", "a.ts")],
              verification_status: "none" as const,
            },
          ],
        ]),
      )
      const program = Effect.gen(function* () {
        const decision = yield* handleStop(stopAt("sid-absolute-path", root))
        const s = yield* SessionState
        const after = yield* s.get("sid-absolute-path")
        return { decision, after }
      })
      const { decision, after } = await Effect.runPromise(
        program.pipe(Effect.provide(layer)),
      )
      expect(decision).toEqual({})
      expect(after.verification_status).toBe("passed")
      expect(after.tests_run).toContain("true")
      expect(after.stop_blocked_once).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("auto-verify fails → Stop blocks with command + output tail; stop_blocked_once stays false", async () => {
    const { root, cleanup } = stage()
    try {
      writeVerifyMap(
        root,
        `rules:
  - source: src/*.ts
    command: ["sh", "-c", "echo boom 1>&2; exit 7"]
    timeoutMs: 5000
`,
      )
      const layer = SessionStateTest(
        new Map([
          [
            "sid-fail",
            {
              ...EMPTY_SESSION_STATE,
              files_changed: ["src/a.ts"],
              verification_status: "none" as const,
            },
          ],
        ]),
      )
      const program = Effect.gen(function* () {
        const decision = yield* handleStop(stopAt("sid-fail", root))
        const s = yield* SessionState
        const after = yield* s.get("sid-fail")
        return { decision, after }
      })
      const { decision, after } = await Effect.runPromise(
        program.pipe(Effect.provide(layer)),
      )
      const d = decision as { decision?: string; reason?: string }
      expect(d.decision).toBe("block")
      expect(d.reason ?? "").toMatch(/Verification failed/)
      expect(d.reason ?? "").toMatch(/boom/)
      expect(after.verification_status).toBe("failed")
      // Critical: verifier failures must NOT consume the one-shot loop
      // guard, otherwise the next Stop is forced through.
      expect(after.stop_blocked_once).toBe(false)
      expect(after.commands_failed.length).toBeGreaterThan(0)
    } finally {
      cleanup()
    }
  })

  test("auto-verify timeout → Stop blocks with timeout reason", async () => {
    const { root, cleanup } = stage()
    try {
      writeVerifyMap(
        root,
        `rules:
  - source: src/*.ts
    command: ["sh", "-c", "sleep 5"]
    timeoutMs: 200
`,
      )
      const layer = SessionStateTest(
        new Map([
          [
            "sid-timeout",
            {
              ...EMPTY_SESSION_STATE,
              files_changed: ["src/a.ts"],
              verification_status: "none" as const,
            },
          ],
        ]),
      )
      const program = Effect.gen(function* () {
        return yield* handleStop(stopAt("sid-timeout", root))
      })
      const decision = await Effect.runPromise(
        program.pipe(Effect.provide(layer)),
      )
      const d = decision as { decision?: string; reason?: string }
      expect(d.decision).toBe("block")
      expect(d.reason ?? "").toMatch(/timeout/i)
    } finally {
      cleanup()
    }
  })

  test("no verify-map rule matches → existing reminder block still fires", async () => {
    const { root, cleanup } = stage()
    try {
      writeVerifyMap(
        root,
        `rules:
  - source: docs/*.md
    command: ["true"]
`,
      )
      const layer = SessionStateTest(
        new Map([
          [
            "sid-nomatch",
            {
              ...EMPTY_SESSION_STATE,
              files_changed: ["src/a.ts"],
              verification_status: "none" as const,
            },
          ],
        ]),
      )
      const program = Effect.gen(function* () {
        const decision = yield* handleStop(stopAt("sid-nomatch", root))
        const s = yield* SessionState
        const after = yield* s.get("sid-nomatch")
        return { decision, after }
      })
      const { decision, after } = await Effect.runPromise(
        program.pipe(Effect.provide(layer)),
      )
      const d = decision as { decision?: string; reason?: string }
      expect(d.decision).toBe("block")
      expect(d.reason ?? "").toMatch(/verification command has run/)
      // Verification reminders keep blocking until a real check runs.
      expect(after.stop_blocked_once).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("verify-map.yaml absent → behavior identical to pre-feature (reminder block)", async () => {
    const { root, cleanup } = stage()
    try {
      const layer = SessionStateTest(
        new Map([
          [
            "sid-nofile",
            {
              ...EMPTY_SESSION_STATE,
              files_changed: ["src/a.ts"],
              verification_status: "none" as const,
            },
          ],
        ]),
      )
      const decision = await Effect.runPromise(
        handleStop(stopAt("sid-nofile", root)).pipe(Effect.provide(layer)),
      )
      const d = decision as { decision?: string; reason?: string }
      expect(d.decision).toBe("block")
      expect(d.reason ?? "").toMatch(/verification command has run/)
    } finally {
      cleanup()
    }
  })

  test("verification_status already passed → verifier skipped (cache hit)", async () => {
    const { root, cleanup } = stage()
    try {
      // Even with a failing command in the map, the verifier should not run
      // because state is already passed (heuristic detection from a prior
      // PostToolBatch). This proves we honor the heuristic cache.
      writeVerifyMap(
        root,
        `rules:
  - source: src/*.ts
    command: ["false"]
`,
      )
      const layer = SessionStateTest(
        new Map([
          [
            "sid-cached",
            {
              ...EMPTY_SESSION_STATE,
              files_changed: ["src/a.ts"],
              verification_status: "passed" as const,
            },
          ],
        ]),
      )
      const decision = await Effect.runPromise(
        handleStop(stopAt("sid-cached", root)).pipe(Effect.provide(layer)),
      )
      expect(decision).toEqual({})
    } finally {
      cleanup()
    }
  })

  test("higher-priority rule wins when multiple match", async () => {
    const { root, cleanup } = stage()
    try {
      // First rule (priority 100, default) prints "broad"; second (priority
      // 1) prints "narrow". Verifier should run the narrow one and pass.
      writeVerifyMap(
        root,
        `rules:
  - source: src/*.ts
    command: ["sh", "-c", "echo broad; exit 1"]
  - source: src/*.ts
    command: ["sh", "-c", "echo narrow; exit 0"]
    priority: 1
`,
      )
      const layer = SessionStateTest(
        new Map([
          [
            "sid-priority",
            {
              ...EMPTY_SESSION_STATE,
              files_changed: ["src/a.ts"],
              verification_status: "none" as const,
            },
          ],
        ]),
      )
      const program = Effect.gen(function* () {
        const decision = yield* handleStop(stopAt("sid-priority", root))
        const s = yield* SessionState
        const after = yield* s.get("sid-priority")
        return { decision, after }
      })
      const { decision, after } = await Effect.runPromise(
        program.pipe(Effect.provide(layer)),
      )
      expect(decision).toEqual({})
      expect(after.verification_status).toBe("passed")
      // Tests-run records the narrow command, not the broad one.
      expect(after.tests_run.some((c) => c.includes("narrow"))).toBe(true)
      expect(after.tests_run.some((c) => c.includes("broad"))).toBe(false)
    } finally {
      cleanup()
    }
  })
})
