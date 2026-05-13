import { describe, expect, test } from "bun:test"
import { Chunk, Effect, Schema, Stream } from "effect"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eventStream } from "../../src/schema/events.ts"
import { EventStore, EventStoreLive } from "../../src/services/event-store.ts"

const TestEventSchema = Schema.Struct({
  id: Schema.String,
  tool_input: Schema.Unknown,
  prompt: Schema.Unknown,
  nested: Schema.Struct({
    content: Schema.Unknown,
  }),
})

describe("EventStoreLive", () => {
  test("redacts sensitive fields before JSONL persistence", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-events-"))
    try {
      const file = join(root, "events.jsonl")
      const stream = eventStream("test", file, TestEventSchema)

      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* EventStore
          yield* store.append(stream, {
            id: "evt-1",
            tool_input: { command: "cat secret.txt" },
            prompt: "raw user prompt",
            nested: { content: { elicitation: "approve deployment" } },
          })
        }).pipe(Effect.provide(EventStoreLive)),
      )

      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        tool_input: { redacted: boolean }
        prompt: { redacted: boolean }
        nested: { content: { redacted: boolean } }
      }
      expect(parsed.tool_input.redacted).toBe(true)
      expect(parsed.prompt.redacted).toBe(true)
      expect(parsed.nested.content.redacted).toBe(true)
      expect(readFileSync(file, "utf8")).not.toContain("raw user prompt")
      expect(readFileSync(file, "utf8")).not.toContain("secret.txt")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("redacts circular sensitive values without failing append", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-events-"))
    try {
      const file = join(root, "circular.jsonl")
      const stream = eventStream("circular", file, TestEventSchema)
      const circular: { prompt?: unknown; self?: unknown } = {}
      circular.prompt = "secret prompt"
      circular.self = circular

      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* EventStore
          yield* store.append(stream, {
            id: "evt-1",
            tool_input: circular,
            prompt: circular,
            nested: { content: circular },
          })
        }).pipe(Effect.provide(EventStoreLive)),
      )

      const persisted = readFileSync(file, "utf8")
      expect(persisted).toContain("redacted")
      expect(persisted).not.toContain("secret prompt")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("tail schema-decodes records and returns only the requested suffix", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-events-"))
    try {
      const file = join(root, "tail.jsonl")
      const stream = eventStream("tail", file, Schema.Struct({ id: Schema.Number }))
      const records = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* EventStore
          yield* store.append(stream, { id: 1 })
          yield* store.append(stream, { id: 2 })
          yield* store.append(stream, { id: 3 })
          return yield* Stream.runCollect(store.tail(stream, 2)).pipe(Effect.map(Chunk.toReadonlyArray))
        }).pipe(Effect.provide(EventStoreLive)),
      )

      expect(records.map((r) => r.id)).toEqual([2, 3])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("tail drops a truncated leading line from bounded suffix reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-events-"))
    try {
      const file = join(root, "bounded-tail.jsonl")
      writeFileSync(
        file,
        `${JSON.stringify({ id: 1, pad: "x".repeat(200) })}\n${JSON.stringify({ id: 2 })}\n${JSON.stringify({ id: 3 })}\n`,
      )
      const stream = eventStream("bounded-tail", file, Schema.Struct({ id: Schema.Number, pad: Schema.optional(Schema.String) }), {
        maxTailBytes: 40,
      })
      const records = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* EventStore
          return yield* Stream.runCollect(store.tail(stream, 10)).pipe(Effect.map(Chunk.toReadonlyArray))
        }).pipe(Effect.provide(EventStoreLive)),
      )

      expect(records.map((r) => r.id)).toEqual([2, 3])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("tail keeps a valid final JSONL line without a trailing newline", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-events-"))
    try {
      const file = join(root, "no-newline.jsonl")
      writeFileSync(file, `${JSON.stringify({ id: 1 })}\n${JSON.stringify({ id: 2 })}`)
      const stream = eventStream("no-newline", file, Schema.Struct({ id: Schema.Number }))
      const records = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* EventStore
          return yield* Stream.runCollect(store.tail(stream, 10)).pipe(Effect.map(Chunk.toReadonlyArray))
        }).pipe(Effect.provide(EventStoreLive)),
      )

      expect(records.map((r) => r.id)).toEqual([1, 2])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("tail with zero requested records returns an empty stream", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-events-"))
    try {
      const file = join(root, "zero.jsonl")
      const stream = eventStream("zero", file, Schema.Struct({ id: Schema.Number }))
      const records = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* EventStore
          yield* store.append(stream, { id: 1 })
          return yield* Stream.runCollect(store.tail(stream, 0)).pipe(Effect.map(Chunk.toReadonlyArray))
        }).pipe(Effect.provide(EventStoreLive)),
      )

      expect(records).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects records that fail the stream schema", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-events-"))
    try {
      const file = join(root, "schema.jsonl")
      const stream = eventStream("schema", file, Schema.Struct({ id: Schema.Number }))
      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const store = yield* EventStore
          yield* store.append(stream, { id: "bad" } as never)
        }).pipe(Effect.provide(EventStoreLive)),
      )

      expect(result._tag).toBe("Failure")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
