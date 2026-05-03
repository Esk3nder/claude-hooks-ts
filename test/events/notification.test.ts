import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { handleNotification } from "../../src/events/notification.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { FileSystem, FileSystemTest } from "../../src/services/filesystem.ts"
import { ProjectTest } from "../../src/services/project.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

describe("handleNotification", () => {
  test("ledger entry + SAFE_DEFAULT", async () => {
    const layer = Layer.mergeAll(FileSystemTest(), ProjectTest({ root: "/proj" }))
    const payload = decode({
      _tag: "Notification",
      session_id: "s1",
      hook_event_name: "Notification",
      notification_type: "info",
      message: "hello",
    })
    const program = Effect.gen(function* () {
      const d = yield* handleNotification(payload)
      const fs = yield* FileSystem
      const c = yield* fs.readFile("/proj/.claude-hooks/state/notifications.jsonl")
      return { d, c }
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.d).toEqual({})
    expect(JSON.parse(r.c.trim()).message).toBe("hello")
  })
})
