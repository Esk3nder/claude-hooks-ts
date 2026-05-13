import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { EventStoreError } from "../../src/schema/errors.ts"
import { EventStore } from "../../src/services/event-store.ts"
import { Ledger, LedgerLiveBase } from "../../src/services/ledger.ts"

const failingEventStore = (failure: EventStoreError): Layer.Layer<EventStore> =>
  Layer.succeed(
    EventStore,
    EventStore.of({
      append: () => Effect.fail(failure),
      tail: () => Stream.fail(failure),
      compact: () => Effect.fail(failure),
    }),
  )

describe("LedgerLiveBase", () => {
  test("event-store failures are summarized without serializing raw causes", async () => {
    const failure = new EventStoreError({
      op: "tail",
      stream: "session-ledger:s1",
      path: "/repo/.claude-hooks/state/s1/ledger.jsonl",
      message: "event schema decode failed",
      cause: { tool_input: "TOP_SECRET_LEDGER_CAUSE", prompt: "TOP_SECRET_LEDGER_PROMPT" },
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        return yield* Effect.either(ledger.read("s1"))
      }).pipe(Effect.provide(Layer.provide(LedgerLiveBase("/repo"), failingEventStore(failure)))),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.message).toBe("tail failed for session-ledger:s1: event schema decode failed")
      expect(JSON.stringify(result.left)).not.toContain("TOP_SECRET_LEDGER_CAUSE")
      expect(JSON.stringify(result.left)).not.toContain("TOP_SECRET_LEDGER_PROMPT")
      expect(JSON.stringify(result.left)).not.toContain("tool_input")
      expect(JSON.stringify(result.left)).not.toContain("prompt")
    }
  })
})
