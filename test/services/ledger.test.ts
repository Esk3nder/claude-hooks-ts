import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { EventStoreError } from "../../src/schema/errors.ts"
import { EventStore, EventStoreLive } from "../../src/services/event-store.ts"
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

  test("session IDs are sanitized before becoming ledger directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-state-"))
    const maliciousSid = "../escape"
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const ledger = yield* Ledger
          yield* ledger.append({
            timestamp: 1,
            event: "Test",
            sessionId: maliciousSid,
            data: { ok: true },
          })
          return yield* ledger.read(maliciousSid)
        }).pipe(Effect.provide(Layer.provide(LedgerLiveBase(root), EventStoreLive))),
      )

      expect(fsSync.existsSync(path.join(root, ".claude-hooks", "escape", "ledger.jsonl"))).toBe(false)
      const stateDir = path.join(root, ".claude-hooks", "state")
      const dirs = fsSync.readdirSync(stateDir)
      expect(dirs.length).toBe(1)
      expect(dirs[0]).toStartWith("escape-")
      expect(dirs[0]).not.toContain("..")
      expect(fsSync.existsSync(path.join(stateDir, dirs[0]!, "ledger.jsonl"))).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
