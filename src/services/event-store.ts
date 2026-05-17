import { Chunk, Context, Effect, Layer, Ref, Stream } from "effect"
import { Schema } from "effect"
import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as path from "node:path"
import { EventStoreError } from "../schema/errors.ts"
import type { EventStream, EventStreamName } from "../schema/events.ts"
import { FileLock, FileLockPlatformLive } from "./file-lock.ts"
import { logWarning } from "./diagnostics.ts"

const DEFAULT_MAX_LINE_BYTES = 32 * 1024
const DEFAULT_MAX_TAIL_BYTES = 1024 * 1024
const DEFAULT_MAX_RECORDS = 1_000
const MAX_STRING_CHARS = 4_096
const MAX_ARRAY_ITEMS = 100
const MAX_OBJECT_KEYS = 100
const MAX_DEPTH = 8

const SENSITIVE_KEYS = new Set([
  "tool_input",
  "toolinput",
  "prompt",
  "prompttext",
  "elicitation",
  "content",
])

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

const normalizeSensitiveKey = (key: string): string =>
  key.replace(/[^A-Za-z0-9]/g, "").toLowerCase()

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
  if (
    key !== undefined &&
    (sensitiveKeys.has(key.toLowerCase()) || sensitiveKeys.has(normalizeSensitiveKey(key)))
  ) {
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
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactForPersistence(item, undefined, depth + 1, options))
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

export const isRedactedPersistenceMarker = (
  value: unknown,
): value is { readonly redacted: true; readonly sha256: string; readonly bytes: number } =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (value as { redacted?: unknown }).redacted === true &&
  typeof (value as { sha256?: unknown }).sha256 === "string" &&
  typeof (value as { bytes?: unknown }).bytes === "number"

export const containsRedactedPersistenceMarker = (
  value: unknown,
  depth = 0,
): boolean => {
  if (isRedactedPersistenceMarker(value)) return true
  if (value === null || value === undefined || depth >= MAX_DEPTH) return false
  if (typeof value !== "object") return false
  if (Array.isArray(value)) {
    return value.some((item) => containsRedactedPersistenceMarker(item, depth + 1))
  }
  return Object.values(value as Record<string, unknown>).some((item) =>
    containsRedactedPersistenceMarker(item, depth + 1),
  )
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

interface RegisteredStream {
  readonly stream: EventStream<unknown>
  readonly ambiguous: boolean
}

const streamPathKey = (stream: EventStream<unknown>): string => path.resolve(stream.path)

const streamRecordKey = (stream: EventStream<unknown>): string => `${stream.name}\0${streamPathKey(stream)}`

const sameStreamTarget = (a: EventStream<unknown>, b: EventStream<unknown>): boolean =>
  streamPathKey(a) === streamPathKey(b)

const registerStream = <A>(
  registry: ReadonlyMap<EventStreamName, RegisteredStream>,
  stream: EventStream<A>,
): Map<EventStreamName, RegisteredStream> => {
  const next = new Map(registry)
  const existing = next.get(stream.name)
  const candidate = stream as EventStream<unknown>
  if (existing === undefined) {
    next.set(stream.name, { stream: candidate, ambiguous: false })
    return next
  }
  next.set(stream.name, {
    stream: existing.stream,
    ambiguous: existing.ambiguous || !sameStreamTarget(existing.stream, candidate),
  })
  return next
}

const compactTarget = (
  name: EventStreamName,
  registry: ReadonlyMap<EventStreamName, RegisteredStream>,
): Effect.Effect<EventStream<unknown>, EventStoreError> => {
  const registered = registry.get(name)
  if (registered === undefined) {
    return Effect.fail(
      new EventStoreError({ op: "compact", stream: name, path: "", message: "unknown stream" }),
    )
  }
  if (registered.ambiguous) {
    return Effect.fail(
      new EventStoreError({
        op: "compact",
        stream: name,
        path: registered.stream.path,
        message: "ambiguous stream name; multiple paths registered",
      }),
    )
  }
  return Effect.succeed(registered.stream)
}

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
    const rawEndsWithNewline = tail.raw.length === 0 || /(?:\r?\n)$/.test(tail.raw)
    const out: A[] = []
    let malformedLines = 0
    let decodeFailures = 0
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i] ?? ""
      if (line.trim().length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        if (stream.strictTail === true && !rawEndsWithNewline && i === rawLines.length - 1) {
          yield* logWarning(
            `[event-store] ignored partial trailing JSONL record while tailing ${stream.name}`,
          )
          continue
        }
        malformedLines += 1
        continue
      }
      const decoded = yield* decodeEvent(stream, parsed, "tail").pipe(Effect.either)
      if (decoded._tag === "Right") {
        out.push(decoded.right)
      } else {
        decodeFailures += 1
      }
    }
    if (malformedLines > 0 || decodeFailures > 0) {
      yield* logWarning(
        `[event-store] skipped invalid JSONL record(s) while tailing ${stream.name}: malformed=${malformedLines} decode_failed=${decodeFailures}`,
      )
      if (stream.strictTail === true) {
        return yield* Effect.fail(
          makeError(
            "tail",
            stream as EventStream<unknown>,
            `invalid JSONL record(s) in strict stream: malformed=${malformedLines} decode_failed=${decodeFailures}`,
          ),
        )
      }
    }
    return out.slice(-limit)
  })

const readTail = <A>(stream: EventStream<A>, n: number): Effect.Effect<ReadonlyArray<A>, EventStoreError> =>
  Effect.tryPromise({
    try: () => readTailText(stream.path, stream.maxTailBytes ?? DEFAULT_MAX_TAIL_BYTES),
    catch: (cause) => makeError("tail", stream as EventStream<unknown>, "tail read failed", cause),
  }).pipe(Effect.flatMap((tail) => parseTail(stream, tail, Math.min(n, stream.maxRecords ?? DEFAULT_MAX_RECORDS))))

const writeAll = <A>(stream: EventStream<A>, records: ReadonlyArray<A>): Effect.Effect<void, EventStoreError> =>
  Effect.tryPromise({
    try: async () => {
      const dir = path.dirname(stream.path)
      const tmp = path.join(
        dir,
        `.${path.basename(stream.path)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.compact.tmp`,
      )
      await fs.mkdir(dir, { recursive: true })
      const lines = await Effect.runPromise(Effect.all(records.map((record) => encodeLine(stream, record))))
      try {
        await fs.writeFile(tmp, lines.join(""), "utf8")
        await fs.rename(tmp, stream.path)
      } catch (cause) {
        await fs.rm(tmp, { force: true }).catch(() => undefined)
        throw cause
      }
    },
    catch: (cause) => makeError("compact", stream as EventStream<unknown>, "compact write failed", cause),
  })

export const summarizeEventStoreError = (cause: unknown): string => {
  if (cause instanceof EventStoreError) {
    return `${cause.op} failed for ${cause.stream}: ${cause.message}`
  }
  return "event-store operation failed"
}

export const EventStoreLiveBase: Layer.Layer<EventStore, never, FileLock> = Layer.effect(
  EventStore,
  Effect.gen(function* () {
    const locks = yield* FileLock
    const streams = yield* Ref.make<Map<EventStreamName, RegisteredStream>>(new Map())
    const remember = <A>(stream: EventStream<A>): Effect.Effect<void> =>
      Ref.update(streams, (map) => registerStream(map, stream))
    return EventStore.of({
      append: <A>(stream: EventStream<A>, event: A) =>
        Effect.gen(function* () {
          yield* remember(stream)
          const line = yield* encodeLine(stream, event)
          yield* locks.withLock(
            stream.path,
            Effect.tryPromise({
              try: async () => {
                await fs.mkdir(path.dirname(stream.path), { recursive: true })
                await fs.appendFile(stream.path, line, "utf8")
              },
              catch: (cause) => makeError("append", stream as EventStream<unknown>, "append write failed", cause),
            }),
          ).pipe(
            Effect.mapError((cause) =>
              cause instanceof EventStoreError
                ? cause
                : makeError("append", stream as EventStream<unknown>, "append write failed", cause),
            ),
          )
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
          const stream = yield* compactTarget(name, map)
          yield* locks.withLock(
            stream.path,
            Effect.gen(function* () {
              const records = yield* readTail(stream, stream.maxRecords ?? DEFAULT_MAX_RECORDS)
              const compacted = stream.compactRecords?.(records) ?? records
              yield* writeAll(stream, compacted)
            }),
          ).pipe(
            Effect.mapError((cause) =>
              cause instanceof EventStoreError
                ? cause
                : makeError("compact", stream, "compact failed", cause),
            ),
          )
        }),
    })
  }),
)

export const EventStoreLive: Layer.Layer<EventStore> =
  Layer.provide(EventStoreLiveBase, FileLockPlatformLive)

export const collectStream = <A, E>(stream: Stream.Stream<A, E>): Effect.Effect<ReadonlyArray<A>, E> =>
  Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray))

export const EventStoreTest = (): Layer.Layer<EventStore> =>
  Layer.effect(
    EventStore,
    Effect.gen(function* () {
      const records = yield* Ref.make<Map<string, ReadonlyArray<unknown>>>(new Map())
      const streams = yield* Ref.make<Map<EventStreamName, RegisteredStream>>(new Map())
      const remember = <A>(stream: EventStream<A>): Effect.Effect<void> =>
        Ref.update(streams, (map) => registerStream(map, stream))
      return EventStore.of({
        append: <A>(stream: EventStream<A>, event: A) =>
          Effect.gen(function* () {
            yield* remember(stream)
            const decoded = yield* prepareEvent(stream, event, "append")
            yield* ensureLineWithinCap(stream, JSON.stringify(decoded), "append")
            yield* Ref.update(records, (map) => {
              const next = new Map(map)
              const key = streamRecordKey(stream as EventStream<unknown>)
              next.set(key, [...(next.get(key) ?? []), decoded])
              return next
            })
          }),
        tail: <A>(stream: EventStream<A>, n: number) =>
          Stream.unwrap(
            remember(stream).pipe(
              Effect.zipRight(Ref.get(records)),
              Effect.map((map) =>
                Stream.fromIterable((() => {
                  const limit = Math.max(0, Math.min(n, stream.maxRecords ?? DEFAULT_MAX_RECORDS))
                  if (limit === 0) return [] as A[]
                  const key = streamRecordKey(stream as EventStream<unknown>)
                  return (map.get(key) ?? []).slice(-limit) as A[]
                })()),
              ),
            ),
          ),
        compact: (name) =>
          Effect.gen(function* () {
            const map = yield* Ref.get(streams)
            const stream = yield* compactTarget(name, map)
            const key = streamRecordKey(stream)
            yield* Ref.update(records, (recordMap) => {
              const next = new Map(recordMap)
              const current = next.get(key) ?? []
              const retained = current.slice(-(stream.maxRecords ?? DEFAULT_MAX_RECORDS))
              next.set(key, stream.compactRecords?.(retained) ?? retained)
              return next
            })
          }),
      })
    }),
  )
