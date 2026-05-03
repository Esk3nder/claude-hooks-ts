import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { handleSetup } from "../../src/events/setup.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { FileSystem, FileSystemTest } from "../../src/services/filesystem.ts"
import { ProjectTest } from "../../src/services/project.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

describe("handleSetup", () => {
  test("appends ledger entry and returns SAFE_DEFAULT", async () => {
    const layer = Layer.mergeAll(FileSystemTest(), ProjectTest({ root: "/proj" }))
    const payload = decode({
      _tag: "Setup",
      session_id: "s1",
      hook_event_name: "Setup",
      trigger: "init",
    })
    const program = Effect.gen(function* () {
      const d = yield* handleSetup(payload)
      const fs = yield* FileSystem
      const content = yield* fs.readFile("/proj/.claude-hooks/state/setup.jsonl")
      return { d, content }
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.d).toEqual({})
    const parsed = JSON.parse(r.content.trim().split("\n")[0]!)
    expect(parsed.session_id).toBe("s1")
    expect(parsed.trigger).toBe("init")
  })

  test("non-Setup payload is no-op", async () => {
    const layer = Layer.mergeAll(FileSystemTest(), ProjectTest({ root: "/proj" }))
    const payload = decode({ _tag: "Stop", session_id: "x", hook_event_name: "Stop" })
    const d = await Effect.runPromise(
      handleSetup(payload).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
  })
})
