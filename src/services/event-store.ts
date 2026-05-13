import { Chunk, Context, Effect, Layer, Ref, Stream } from "effect"
import { Schema } from "effect"
import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as path from "node:path"
import { EventStoreError } from "../schema/errors.ts"
import type { EventStream, EventStreamName } from "../schema/events.ts"
import { withFileLock } from "./file-lock.ts"

const DEFAULT_MAX_LINE_BYTES = 32 * 1024
const DEFAULT_MAX_TAIL_BYTES = 1024 * 1024
const DEFAULT_MAX_RECORDS = 1_000
const MAX_STRING_CHARS = 4_096
const MAX_ARRAY_ITEMS = 100
const MAX_OBJECT_KEYS = 100
const MAX_DEPTH = 8

const SENSITIVE_KEYS = new Set(["tool_input", "prompt", "elicitation", "content"])

interface RedactionOptions {
  readonly sensitiveKeys?: ReadonlySet<string>
}

export interface EventStoreApi {
  readonly append: <A>(stream: EventStream<A>, event: A) => Effect.Effect<void, EventStoreError>
  readonly tail: <A>(stream: EventStream<A>, n: number) => Stream.Stream<A, EventStoreError>
  readonly compact: (stream: EventStreamName) => Effect.Effect<void, EventStoreError>
}

export class EventStore extends Context.Tag("EventStore")<EventStore, EventStoreApi>() {}

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8")

const safeJsonString = (value: unknown): string => {
  try {
    const serialized = JSON.stringify(value ?? null)
    return typeof serialized === "string" ? serialized : String(value)
  } catch {
    return String(value)
  }
}

const hashUnknown = (value: unknown): string => {
  const serialized = safeJsonString(value)
  return crypto.createHash("sha256").update(serialized ?? "null").digest("hex").slice(0, 16)
}

const capString = (value: string): string => {
  if (value.length <= MAX_STRING_CHARS && byteLength(value) <= MAX_STRING_CHARS * 4) return value
  return `${value.slice(0, MAX_STRING_CHARS)}...[truncated bytes=${byteLength(value)}]`
}

export const redactForPersistence = (
  value: unknown,
  key: string | undefined = undefined,
  depth = 0,
  options: RedactionOptions = {},
): unknown => {
  const sensitiveKeys = options.sensitiveKeys ?? SENSITIVE_KEYS
  if (key !== undefined && sensitiveKeys.has(key.toLowerCase())) {
    const serialized = safeJsonString(value)
    return {
      redacted: true,
      sha256: hashUnknown(value),
      bytes: byteLength(serialized),
    }
  }
  if (typeof value === "string") return capString(value)
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value
  if (value === undefined) return undefined
  if (typeof value !== "object") return String(value)
  if (depth >= MAX_DEPTH) return { truncated: true, reason: "max_depth" }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactForPersistence(item, undefined, depth + 1, options))
    if (value.length > MAX_ARRAY_ITEMS) items.push({ truncated: true, omitted: value.length - MAX_ARRAY_ITEMS })
    return items
  }
  const out: Record<string, unknown> = {}
  let allEntries: Array<[string, unknown]>
  try {
    allEntries = Object.entries(value as Record<string, unknown>)
  } catch {
    return { truncated: true, reason: "unreadable_object" }
  }
  const entries = allEntries.slice(0, MAX_OBJECT_KEYS)
  for (const [childKey, childValue] of entries) {
    out[childKey] = redactForPersistence(childValue, childKey, depth + 1, options)
  }
  const omitted = allEntries.length - entries.length
  if (omitted > 0) out["__truncated_keys"] = omitted
  return out
}

const makeError = (
  op: string,
  stream: EventStream<unknown>,
  message: string,
  cause?: unknown,
): EventStoreError =>
  new EventStoreError({
    op,
    stream: stream.name,
    path: stream.path,
    message,
    cause,
  })

const decodeEvent = <A>(stream: EventStream<A>, value: unknown, op: string): Effect.Effect<A, EventStoreError> =>
  Schema.decodeUnknown(stream.schema)(value).pipe(
    Effect.mapError((cause) => makeError(op, stream as EventStream<unknown>, "event schema decode failed", cause)),
  )

const redactedEvent = <A>(stream: EventStream<A>, event: A): unknown =>
  stream.redact === undefined ? redactForPersistence(event) : stream.redact(event)

const prepareEvent = <A>(stream: EventStream<A>, event: A, op: string): Effect.Effect<A, EventStoreError> =>
  decodeEvent(stream, redactedEvent(stream, event), op)

const ensureLineWithinCap = <A>(stream: EventStream<A>, serialized: string, op: string): Effect.Effect<void, EventStoreError> => {
  if (serialized.includes("\n")) {
    return Effect.fail(makeError(op, stream as EventStream<unknown>, "event serialized with newline"))
  }
  const maxLineBytes = stream.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
  if (byteLength(serialized) > maxLineBytes) {
    return Effect.fail(
      makeError(op, stream as EventStream<unknown>, `event exceeded ${maxLineBytes} byte line cap`),
    )
  }
  return Effect.void
}

const encodeLine = <A>(stream: EventStream<A>, event: A): Effect.Effect<string, EventStoreError> =>
  Effect.gen(function* () {
    const decoded = yield* prepareEvent(stream, event, "append")
    const serialized = JSON.stringify(decoded)
    yield* ensureLineWithinCap(stream, serialized, "append")
    return `${serialized}\n`
  })

interface TailText {
  readonly raw: string
  readonly truncatedStart: boolean
}

const readTailText = async (file: string, maxTailBytes: number): Promise<TailText> => {
  if (maxTailBytes <= 0 || !fsSync.existsSync(file)) return { raw: "", truncatedStart: false }
  let handle: fs.FileHandle
  try {
    handle = await fs.open(file, "r")
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && (cause as { code?: string }).code === "ENOENT") {
      return { raw: "", truncatedStart: false }
    }
    throw cause
  }
  try {
    const stat = await handle.stat()
    const length = Math.min(stat.size, maxTailBytes)
    const buffer = Buffer.alloc(length)
    const start = Math.max(0, stat.size - length)
    let offset = 0
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    let truncatedStart = start > 0
    if (start > 0) {
      const previous = Buffer.alloc(1)
      const { bytesRead } = await handle.read(previous, 0, 1, start - 1)
      if (bytesRead === 1 && (previous[0] === 0x0a || previous[0] === 0x0d)) {
        truncatedStart = false
      }
    }
    return {
      raw: buffer.subarray(0, offset).toString("utf8"),
      truncatedStart,
    }
  } finally {
    await handle.close()
  }
}

const parseTail = <A>(
  stream: EventStream<A>,
  tail: TailText,
  n: number,
): Effect.Effect<ReadonlyArray<A>, EventStoreError> =>
  Effect.gen(function* () {
    const limit = Math.max(0, n)
    if (limit === 0) return []
    let rawLines = tail.raw.split(/\r?\n/)
    if (tail.truncatedStart && rawLines.length > 0) rawLines = rawLines.slice(1)
    const out: A[] = []
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i] ?? ""
      if (line.trim().length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (cause) {
        const trailingPartial = tail.raw.length > 0 && !tail.raw.endsWith("\n") && i === rawLines.length - 1
        if (trailingPartial) continue
        return yield* Effect.fail(makeError("tail", stream as EventStream<unknown>, "jsonl parse failed", cause))
      }
      out.push(yield* decodeEvent(stream, parsed, "tail"))
    }
    return out.slice(-limit)
  })

const readTail = <A>(stream: EventStream<A>, n: number): Effect.Effect<ReadonlyArray<A>, EventStoreError> =>
  Effect.tryPromise({
    try: () => readTailText(stream.path, stream.maxTailBytes ?? DEFAULT_MAX_TAIL_BYTES),
    catch: (cause) => makeError("tail", stream as EventStream<unknown>, String(cause), cause),
  }).pipe(Effect.flatMap((tail) => parseTail(stream, tail, Math.min(n, stream.maxRecords ?? DEFAULT_MAX_RECORDS))))

const writeAll = <A>(stream: EventStream<A>, records: ReadonlyArray<A>): Effect.Effect<void, EventStoreError> =>
  Effect.tryPromise({
    try: async () => {
      await fs.mkdir(path.dirname(stream.path), { recursive: true })
      const body = records.map((record) => JSON.stringify(record)).join("\n")
      await fs.writeFile(stream.path, body.length === 0 ? "" : `${body}\n`, "utf8")
    },
    catch: (cause) => makeError("compact", stream as EventStream<unknown>, String(cause), cause),
  })

export const EventStoreLive: Layer.Layer<EventStore> = Layer.effect(
  EventStore,
  Effect.gen(function* () {
    const streams = yield* Ref.make<Map<EventStreamName, EventStream<unknown>>>(new Map())
    const remember = <A>(stream: EventStream<A>): Effect.Effect<void> =>
      Ref.update(streams, (map) => new Map(map).set(stream.name, stream as EventStream<unknown>))
    return EventStore.of({
      append: <A>(stream: EventStream<A>, event: A) =>
        Effect.gen(function* () {
          yield* remember(stream)
          const line = yield* encodeLine(stream, event)
          yield* Effect.tryPromise({
            try: async () => {
              await fs.mkdir(path.dirname(stream.path), { recursive: true })
              await withFileLock(stream.path, async () => {
                await fs.appendFile(stream.path, line, "utf8")
              })
            },
            catch: (cause) => makeError("append", stream as EventStream<unknown>, String(cause), cause),
          })
        }),
      tail: <A>(stream: EventStream<A>, n: number) =>
        Stream.unwrap(
          remember(stream).pipe(
            Effect.zipRight(readTail(stream, n)),
            Effect.map((records) => Stream.fromIterable(records)),
          ),
        ),
      compact: (name) =>
        Effect.gen(function* () {
          const map = yield* Ref.get(streams)
          const stream = map.get(name)
          if (stream === undefined) {
            return yield* Effect.fail(
              new EventStoreError({ op: "compact", stream: name, path: "", message: "unknown stream" }),
            )
          }
          yield* Effect.tryPromise({
            try: () =>
              withFileLock(stream.path, async () => {
                const records = await Effect.runPromise(readTail(stream, stream.maxRecords ?? DEFAULT_MAX_RECORDS))
                await Effect.runPromise(writeAll(stream, records))
              }),
            catch: (cause) => makeError("compact", stream, String(cause), cause),
          })
        }),
    })
  }),
)

export const collectStream = <A, E>(stream: Stream.Stream<A, E>): Effect.Effect<ReadonlyArray<A>, E> =>
  Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray))

export const EventStoreTest = (): Layer.Layer<EventStore> =>
  Layer.effect(
    EventStore,
    Effect.gen(function* () {
      const records = yield* Ref.make<Map<EventStreamName, ReadonlyArray<unknown>>>(new Map())
      return EventStore.of({
        append: <A>(stream: EventStream<A>, event: A) =>
          prepareEvent(stream, event, "append").pipe(
            Effect.flatMap((decoded) =>
              ensureLineWithinCap(stream, JSON.stringify(decoded), "append").pipe(
                Effect.zipRight(
                  Ref.update(records, (map) => {
                    const next = new Map(map)
                    next.set(stream.name, [...(next.get(stream.name) ?? []), decoded])
                    return next
                  }),
                ),
              ),
            ),
          ),
        tail: <A>(stream: EventStream<A>, n: number) =>
          Stream.unwrap(
            Ref.get(records).pipe(
              Effect.map((map) =>
                Stream.fromIterable((() => {
                  const limit = Math.max(0, Math.min(n, stream.maxRecords ?? DEFAULT_MAX_RECORDS))
                  if (limit === 0) return [] as A[]
                  return (map.get(stream.name) ?? []).slice(-limit) as A[]
                })()),
              ),
            ),
          ),
        compact: (name) =>
          Ref.update(records, (map) => {
            const next = new Map(map)
            const current = next.get(name) ?? []
            next.set(name, current.slice(-DEFAULT_MAX_RECORDS))
            return next
          }),
      })
    }),
  )
