import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { handlePreCompact } from "../../src/events/precompact-snapshot.ts"
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

const preCompact = (sid: string) =>
  decode({
    _tag: "PreCompact",
    session_id: sid,
    hook_event_name: "PreCompact",
    trigger: "auto",
  })

describe("handlePreCompact (red-team #9)", () => {
  test("emits preservation context with goal, files, next-action; writes snapshot file", async () => {
    const fsLayer = FileSystemTest()
    const layer = Layer.mergeAll(
      fsLayer,
      SessionStateTest(
        new Map([
          [
            "sid-rc9",
            {
              ...EMPTY_SESSION_STATE,
              files_changed: ["/repo/a.ts", "/repo/b.ts"],
              files_read: ["/repo/c.ts"],
              commands_run: ["bun test"],
              next_required_action: "Finish the post-edit hook",
              verification_status: "passed" as const,
              source_urls: ["https://example.com/doc"],
            },
          ],
        ]),
      ),
      ProjectTest({ root: "/proj" }),
    )

    const program = Effect.gen(function* () {
      const decision = yield* handlePreCompact(preCompact("sid-rc9"))
      const fs = yield* FileSystem
      // Find the snapshot file by listing — use exists on the deterministic prefix.
      // Since timestamps vary we read the underlying store via writeFile contract:
      // we re-use the FileSystemTest readFile by capturing all writes; simplest is to
      // verify the decision content (must contain snapshot path) and then read it.
      const out = decision as { hookSpecificOutput: { additionalContext: string } }
      const ctx = out.hookSpecificOutput.additionalContext
      const m = ctx.match(/snapshot: (\S+)/)
      const path = m === null ? "" : m[1]!
      const content = yield* fs.readFile(path)
      return { ctx, content }
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.ctx).toContain("Finish the post-edit hook")
    expect(r.ctx).toContain("/repo/a.ts")
    expect(r.ctx).toContain("bun test")
    expect(r.ctx).toContain("verification: passed")
    expect(r.ctx.length).toBeLessThan(1024)

    expect(r.content).toContain("# Pre-compact preservation snapshot")
    expect(r.content).toContain("/repo/a.ts")
    expect(r.content).toContain("/repo/b.ts")
    expect(r.content).toContain("Finish the post-edit hook")
    expect(r.content).toContain("bun test")
    expect(r.content).toContain("https://example.com/doc")
  })

  test("non-PreCompact payload → SAFE_DEFAULT", async () => {
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
      handlePreCompact(payload).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
  })
})
