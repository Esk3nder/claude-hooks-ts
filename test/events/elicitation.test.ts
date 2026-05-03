import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { handleElicitation } from "../../src/events/elicitation.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { FileSystem, FileSystemTest } from "../../src/services/filesystem.ts"
import { ProjectTest } from "../../src/services/project.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

describe("handleElicitation", () => {
  test("ledger entry + SAFE_DEFAULT", async () => {
    const layer = Layer.mergeAll(FileSystemTest(), ProjectTest({ root: "/proj" }))
    const payload = decode({
      _tag: "Elicitation",
      session_id: "s1",
      hook_event_name: "Elicitation",
      server_name: "mcp.foo",
      tool_name: "ask",
      elicitation: { prompt: "?" },
    })
    const program = Effect.gen(function* () {
      const d = yield* handleElicitation(payload)
      const fs = yield* FileSystem
      const c = yield* fs.readFile("/proj/.claude-hooks/state/elicitations.jsonl")
      return { d, c }
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.d).toEqual({})
    expect(JSON.parse(r.c.trim()).server_name).toBe("mcp.foo")
  })
})
