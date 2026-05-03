import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { handleStopFailure } from "../../src/events/stop-failure.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { FileSystem, FileSystemTest } from "../../src/services/filesystem.ts"
import { ProjectTest } from "../../src/services/project.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

describe("handleStopFailure", () => {
  test("appends to failures.jsonl", async () => {
    const layer = Layer.mergeAll(FileSystemTest(), ProjectTest({ root: "/proj" }))
    const payload = decode({
      _tag: "StopFailure",
      session_id: "s1",
      hook_event_name: "StopFailure",
      error_type: "timeout",
      error_message: "boom",
    })
    const program = Effect.gen(function* () {
      const d = yield* handleStopFailure(payload)
      const fs = yield* FileSystem
      const content = yield* fs.readFile(
        "/proj/.claude-hooks/state/failures.jsonl",
      )
      return { d, content }
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.d).toEqual({})
    const entry = JSON.parse(r.content.trim().split("\n")[0]!)
    expect(entry.error_type).toBe("timeout")
    expect(entry.error_message).toBe("boom")
  })
})
