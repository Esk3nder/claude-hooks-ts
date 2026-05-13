import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { handleStopFailure } from "../../src/events/stop-failure.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { EventStoreLive } from "../../src/services/event-store.ts"
import { ProjectTest } from "../../src/services/project.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

describe("handleStopFailure", () => {
  test("appends to failures.jsonl", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "chts-stop-failure-"))
    try {
      const layer = Layer.mergeAll(EventStoreLive, ProjectTest({ root }))
      const payload = decode({
        _tag: "StopFailure",
        session_id: "s1",
        hook_event_name: "StopFailure",
        error_type: "timeout",
        error_message: "boom",
      })
      const d = await Effect.runPromise(handleStopFailure(payload).pipe(Effect.provide(layer)))
      const content = fs.readFileSync(path.join(root, ".claude-hooks", "state", "failures.jsonl"), "utf8")
      expect(d).toEqual({})
      const entry = JSON.parse(content.trim().split("\n")[0]!)
      expect(entry.error_type).toBe("timeout")
      expect(entry.error_message).toBe("boom")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("redacts authentication failure detail from ledger and context", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "chts-stop-failure-"))
    try {
      const layer = Layer.mergeAll(EventStoreLive, ProjectTest({ root }))
      const payload = decode({
        _tag: "StopFailure",
        session_id: "s1",
        hook_event_name: "StopFailure",
        error_type: "authentication",
        error_message: "Bearer TOP_SECRET_AUTH_TOKEN failed",
      })
      const d = await Effect.runPromise(handleStopFailure(payload).pipe(Effect.provide(layer)))
      const content = fs.readFileSync(path.join(root, ".claude-hooks", "state", "failures.jsonl"), "utf8")
      const context = (d as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
      expect(context).toContain("authentication")
      expect(context).not.toContain("TOP_SECRET_AUTH_TOKEN")
      expect(content).toContain("authentication failure message redacted")
      expect(content).not.toContain("TOP_SECRET_AUTH_TOKEN")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
