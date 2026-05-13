import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { handleSessionEnd } from "../../src/events/session-ledger.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import {
  FileSystem,
  FileSystemTest,
} from "../../src/services/filesystem.ts"
import {
  SessionStateTest,
  EMPTY_SESSION_STATE,
} from "../../src/services/session-state.ts"
import { ProjectTest } from "../../src/services/project.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

describe("handleSessionEnd", () => {
  test("writes summary md to .claude-hooks/state/sessions/<sid>.md", async () => {
    const layer = Layer.mergeAll(
      FileSystemTest(),
      SessionStateTest(
        new Map([
          [
            "sid-end",
            {
              ...EMPTY_SESSION_STATE,
              files_changed: ["/repo/a.ts"],
              commands_run: ["bun test"],
              verification_status: "passed" as const,
            },
          ],
        ]),
      ),
      ProjectTest({ root: "/proj" }),
    )
    const payload = decode({
      _tag: "SessionEnd",
      session_id: "sid-end",
      hook_event_name: "SessionEnd",
      reason: "user-quit",
    })
    const program = Effect.gen(function* () {
      const d = yield* handleSessionEnd(payload)
      const fs = yield* FileSystem
      const content = yield* fs.readFile(
        "/proj/.claude-hooks/state/sessions/sid-end.md",
      )
      return { d, content }
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.d).toEqual({})
    expect(r.content).toContain("# Session summary")
    expect(r.content).toContain("user-quit")
    expect(r.content).toContain("/repo/a.ts")
    expect(r.content).toContain("bun test")
    expect(r.content).toContain("verification_status: passed")
  })

  test("preserves bypass_permissions_disabled and marks it as a permission boundary", async () => {
    const layer = Layer.mergeAll(
      FileSystemTest(),
      SessionStateTest(),
      ProjectTest({ root: "/proj" }),
    )
    const payload = decode({
      _tag: "SessionEnd",
      session_id: "sid-perm",
      hook_event_name: "SessionEnd",
      reason: "bypass_permissions_disabled",
    })
    const program = Effect.gen(function* () {
      yield* handleSessionEnd(payload)
      const fs = yield* FileSystem
      return yield* fs.readFile(
        "/proj/.claude-hooks/state/sessions/sid-perm.md",
      )
    })
    const content = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(content).toContain("- reason: bypass_permissions_disabled")
    expect(content).toContain("- permission_boundary: bypass_permissions_disabled")
  })

  test("non-SessionEnd payload → NO_DECISION, no write", async () => {
    const layer = Layer.mergeAll(
      FileSystemTest(),
      SessionStateTest(),
      ProjectTest({ root: "/proj" }),
    )
    const payload = decode({
      _tag: "Stop",
      session_id: "s",
      hook_event_name: "Stop",
    })
    const d = await Effect.runPromise(
      handleSessionEnd(payload).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
  })
})
