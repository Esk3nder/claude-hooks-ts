import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { handleNotification } from "../../src/events/notification.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { EventStoreLive } from "../../src/services/event-store.ts"
import { ProjectTest } from "../../src/services/project.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

describe("handleNotification", () => {
  test("ledger entry + NO_DECISION", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "chts-notification-"))
    try {
      const layer = Layer.mergeAll(EventStoreLive, ProjectTest({ root }))
      const payload = decode({
        _tag: "Notification",
        session_id: "s1",
        hook_event_name: "Notification",
        notification_type: "info",
        message: "hello",
      })
      const d = await Effect.runPromise(handleNotification(payload).pipe(Effect.provide(layer)))
      const c = fs.readFileSync(path.join(root, ".claude-hooks", "state", "notifications.jsonl"), "utf8")
      expect(d).toEqual({})
      expect(JSON.parse(c.trim()).message).toBe("hello")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
