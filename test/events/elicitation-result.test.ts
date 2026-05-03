import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { handleElicitationResult } from "../../src/events/elicitation-result.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { FileSystem, FileSystemTest } from "../../src/services/filesystem.ts"
import { ProjectTest } from "../../src/services/project.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

describe("handleElicitationResult", () => {
  test("ledger entry + SAFE_DEFAULT", async () => {
    const layer = Layer.mergeAll(FileSystemTest(), ProjectTest({ root: "/proj" }))
    const payload = decode({
      _tag: "ElicitationResult",
      session_id: "s1",
      hook_event_name: "ElicitationResult",
      server_name: "mcp.foo",
      tool_name: "ask",
      action: "accept",
      content: { answer: "yes" },
    })
    const program = Effect.gen(function* () {
      const d = yield* handleElicitationResult(payload)
      const fs = yield* FileSystem
      const c = yield* fs.readFile(
        "/proj/.claude-hooks/state/elicitation-results.jsonl",
      )
      return { d, c }
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.d).toEqual({})
    const e = JSON.parse(r.c.trim())
    expect(e.action).toBe("accept")
    expect(e.content.answer).toBe("yes")
  })
})
