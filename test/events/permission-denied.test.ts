import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { handlePermissionDenied } from "../../src/events/permission-denied.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { FileSystem, FileSystemTest } from "../../src/services/filesystem.ts"
import { ProjectTest } from "../../src/services/project.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

describe("handlePermissionDenied", () => {
  test("appends jsonl with denial details", async () => {
    const layer = Layer.mergeAll(FileSystemTest(), ProjectTest({ root: "/proj" }))
    const payload = decode({
      _tag: "PermissionDenied",
      session_id: "s1",
      hook_event_name: "PermissionDenied",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
      denial_reason: "destructive",
      permission_mode: "default",
    })
    const program = Effect.gen(function* () {
      const d = yield* handlePermissionDenied(payload)
      const fs = yield* FileSystem
      const content = yield* fs.readFile(
        "/proj/.claude-hooks/state/permission-denials.jsonl",
      )
      return { d, content }
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.d).toEqual({})
    const entry = JSON.parse(r.content.trim().split("\n")[0]!)
    expect(entry.tool_name).toBe("Bash")
    expect(entry.denial_reason).toBe("destructive")
    expect(entry.permission_mode).toBe("default")
  })
})
