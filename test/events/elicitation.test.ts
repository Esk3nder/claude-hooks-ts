import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { handleElicitation } from "../../src/events/elicitation.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { ProjectTest } from "../../src/services/project.ts"
import { PolicyConfigTest } from "../../src/services/policy-config.ts"
import { Elicitations, ElicitationsTest, elicitationSignature } from "../../src/services/elicitations.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const samplePayload = decode({
  _tag: "Elicitation", session_id: "s1", hook_event_name: "Elicitation",
  server_name: "mcp.foo", tool_name: "ask", elicitation: { prompt: "?" },
})

describe("handleElicitation", () => {
  test("server in denylist -> decline", async () => {
    const layer = Layer.mergeAll(ProjectTest({ root: "/proj" }), PolicyConfigTest({ elicitationDenylist: ["mcp.foo"] }), ElicitationsTest())
    const d = await Effect.runPromise(handleElicitation(samplePayload).pipe(Effect.provide(layer)))
    const out = (d as { hookSpecificOutput?: { action?: string } }).hookSpecificOutput
    expect(out?.action).toBe("decline")
  })

  test("lookup hit (accept) -> accept with stored content", async () => {
    const sig = elicitationSignature({ prompt: "?" })
    const program = Effect.gen(function* () {
      const e = yield* Elicitations
      yield* e.record("/proj", "mcp.foo", "ask", sig, "accept", { ok: 1 })
      return yield* handleElicitation(samplePayload)
    })
    const layer = Layer.mergeAll(ProjectTest({ root: "/proj" }), PolicyConfigTest({ elicitationDenylist: [] }), ElicitationsTest())
    const d = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    const out = (d as { hookSpecificOutput?: { action?: string; content?: { ok: number } } }).hookSpecificOutput
    expect(out?.action).toBe("accept")
    expect(out?.content?.ok).toBe(1)
  })

  test("lookup miss -> SAFE_DEFAULT", async () => {
    const program = Effect.gen(function* () {
      const d = yield* handleElicitation(samplePayload)
      const e = yield* Elicitations
      const pending = yield* e.findLatestPending(
        "s1",
        "/proj",
        "mcp.foo",
        "ask",
      )
      return { d, pending }
    })
    const layer = Layer.mergeAll(ProjectTest({ root: "/proj" }), PolicyConfigTest({ elicitationDenylist: [] }), ElicitationsTest())
    const { d, pending } = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(d).toEqual({})
    expect(pending?.requestSignature).toBe(elicitationSignature({ prompt: "?" }))
  })
})
