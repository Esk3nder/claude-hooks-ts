import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { handleTeammateIdle } from "../../src/events/teammate-idle.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { FileSystem, FileSystemTest } from "../../src/services/filesystem.ts"
import { ProjectTest } from "../../src/services/project.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

describe("handleTeammateIdle", () => {
  test("ledger entry + SAFE_DEFAULT", async () => {
    const layer = Layer.mergeAll(FileSystemTest(), ProjectTest({ root: "/proj" }))
    const payload = decode({
      _tag: "TeammateIdle",
      session_id: "s1",
      hook_event_name: "TeammateIdle",
      teammate_name: "researcher",
      teammate_type: "subagent",
    })
    const program = Effect.gen(function* () {
      const d = yield* handleTeammateIdle(payload)
      const fs = yield* FileSystem
      const c = yield* fs.readFile("/proj/.claude-hooks/state/teammate-idle.jsonl")
      return { d, c }
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.d).toEqual({})
    expect(JSON.parse(r.c.trim()).teammate_name).toBe("researcher")
  })
})
