import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { handleElicitationResult } from "../../src/events/elicitation-result.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { ProjectTest } from "../../src/services/project.ts"
import {
  Elicitations,
  ElicitationsTest,
  elicitationSignature,
} from "../../src/services/elicitations.ts"
import { FsError } from "../../src/schema/errors.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const payload = decode({
  _tag: "ElicitationResult", session_id: "s1", hook_event_name: "ElicitationResult",
  server_name: "mcp.foo", tool_name: "ask", action: "accept", content: { answer: "yes" },
})

describe("handleElicitationResult", () => {
  test("payload triggers Elicitations.record", async () => {
    const requestSig = elicitationSignature({ prompt: "?" })
    const program = Effect.gen(function* () {
      const e = yield* Elicitations
      yield* e.recordPending(
        "s1",
        "/proj",
        "mcp.foo",
        "ask",
        requestSig,
      )
      const d = yield* handleElicitationResult(payload)
      const stored = yield* e.lookup("/proj", "mcp.foo", "ask", requestSig)
      return { d, stored }
    })
    const layer = Layer.mergeAll(ProjectTest({ root: "/proj" }), ElicitationsTest())
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.d).toEqual({})
    expect(r.stored?.action).toBe("accept")
    expect((r.stored?.content as { answer: string }).answer).toBe("yes")
  })

  test("SAFE_DEFAULT returned even if record fails", async () => {
    const failing = Layer.succeed(Elicitations, Elicitations.of({
      lookup: () => Effect.succeed(null),
      record: () => Effect.fail(new FsError({ op: "elicitations.record", path: "x", message: "boom" })),
      recordPending: () => Effect.succeed(undefined),
      findLatestPending: () => Effect.succeed(null),
      gc: () => Effect.succeed(undefined),
    }))
    const layer = Layer.mergeAll(ProjectTest({ root: "/proj" }), failing)
    const d = await Effect.runPromise(handleElicitationResult(payload).pipe(Effect.provide(layer)))
    expect(d).toEqual({})
  })
})
