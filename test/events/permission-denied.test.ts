import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handlePermissionDenied } from "../../src/events/permission-denied.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { EventStoreLive } from "../../src/services/event-store.ts"
import { ProjectTest } from "../../src/services/project.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

describe("handlePermissionDenied", () => {
  test("appends redacted jsonl with denial details", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-denials-"))
    try {
      const layer = Layer.mergeAll(EventStoreLive, ProjectTest({ root }))
      const payload = decode({
        _tag: "PermissionDenied",
        session_id: "s1",
        hook_event_name: "PermissionDenied",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
        denial_reason: "destructive",
        permission_mode: "default",
      })
      const d = await Effect.runPromise(handlePermissionDenied(payload).pipe(Effect.provide(layer)))
      expect(d).toEqual({})
      const content = readFileSync(join(root, ".claude-hooks", "state", "permission-denials.jsonl"), "utf8")
      const entry = JSON.parse(content.trim().split("\n")[0]!)
      expect(entry.tool_name).toBe("Bash")
      expect(entry.denial_reason).toBe("destructive")
      expect(entry.permission_mode).toBe("default")
      expect(entry.tool_input.redacted).toBe(true)
      expect(content).not.toContain("rm -rf")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
