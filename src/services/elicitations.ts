import { Context, Effect, Layer, Ref, Schema } from "effect"
import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as path from "node:path"
import { createInterface } from "node:readline"
import { FsError } from "../schema/errors.ts"
import {
  ElicitationRecordSchema,
  eventStream,
  PendingElicitationRecordSchema,
} from "../schema/events.ts"
import { collectStream, EventStore, EventStoreLive, redactForPersistence } from "./event-store.ts"
import { withFileLock } from "./file-lock.ts"

export type ElicitationAction = "accept" | "decline" | "cancel"

export interface ElicitationRecord {
  readonly ts: number
  readonly server: string
  readonly tool: string
  readonly signature: string
  readonly action: ElicitationAction
  readonly content?: unknown
  readonly cwd: string
}

export interface PendingElicitationRecord {
  readonly ts: number
  readonly sessionId: string
  readonly cwd: string
  readonly server: string
  readonly tool: string
  readonly requestSignature: string
}

export const DEFAULT_GC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export const elicitationSignature = (value: unknown): string =>
  crypto.createHash("sha1").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 16)

const sanitizeReplayContent = (content: unknown): unknown =>
  typeof content === "string" || Array.isArray(content)
    ? redactForPersistence(content, "content")
    : redactForPersistence(content)

const sanitizeElicitationRecord = (record: ElicitationRecord): ElicitationRecord =>
  record.content === undefined
    ? record
    : { ...record, content: sanitizeReplayContent(record.content) }

export interface ElicitationsApi {
  readonly lookup: (cwd: string, server: string, tool: string, signature: string) => Effect.Effect<ElicitationRecord | null, FsError>
  readonly record: (cwd: string, server: string, tool: string, signature: string, action: ElicitationAction, content?: unknown) => Effect.Effect<void, FsError>
  readonly recordPending: (sessionId: string, cwd: string, server: string, tool: string, requestSignature: string) => Effect.Effect<void, FsError>
  readonly findLatestPending: (sessionId: string, cwd: string, server: string, tool: string) => Effect.Effect<PendingElicitationRecord | null, FsError>
  readonly gc: (cwd: string, now: number, maxAgeMs?: number) => Effect.Effect<void, FsError>
}

export class Elicitations extends Context.Tag("Elicitations")<Elicitations, ElicitationsApi>() {}

const ledgerPath = (cwd: string): string => path.join(cwd, ".claude-hooks", "state", "elicitations.jsonl")

const pendingLedgerPath = (cwd: string): string => path.join(cwd, ".claude-hooks", "state", "elicitations-pending.jsonl")

const elicitationsStream = (cwd: string) =>
  eventStream(`elicitations:${cwd}`, ledgerPath(cwd), ElicitationRecordSchema, {
    maxRecords: 1_000,
    redact: sanitizeElicitationRecord,
  })

const pendingElicitationsStream = (cwd: string) =>
  eventStream(`elicitations-pending:${cwd}`, pendingLedgerPath(cwd), PendingElicitationRecordSchema, {
    maxRecords: 1_000,
  })

const latestMatching = (records: ReadonlyArray<ElicitationRecord>, cwd: string, server: string, tool: string, signature: string): ElicitationRecord | null => {
  let latest: ElicitationRecord | null = null
  for (const rec of records) {
    if (rec.cwd !== cwd || rec.server !== server || rec.tool !== tool || rec.signature !== signature) continue
    if (latest === null || rec.ts >= latest.ts) latest = rec
  }
  return latest
}

const latestPending = (
  records: ReadonlyArray<PendingElicitationRecord>,
  sessionId: string,
  cwd: string,
  server: string,
  tool: string,
): PendingElicitationRecord | null => {
  let latest: PendingElicitationRecord | null = null
  for (const rec of records) {
    if (rec.sessionId !== sessionId || rec.cwd !== cwd || rec.server !== server || rec.tool !== tool) continue
    if (latest === null || rec.ts >= latest.ts) latest = rec
  }
  return latest
}

const rewriteJsonlLedger = async <A>(
  file: string,
  schema: Schema.Schema<A>,
  keep: (record: A) => boolean,
  prepare: (record: A) => A = (record) => record,
): Promise<void> => {
  const tmp = `${file}.${process.pid}.${Date.now()}.gc.tmp`
  let total = 0
  let kept = 0
  let changed = false
  let output: fs.FileHandle | null = null
  try {
    const input = fsSync.createReadStream(file, { encoding: "utf8" })
    output = await fs.open(tmp, "wx")
    const lines = createInterface({ input, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (line.trim().length === 0) continue
        total += 1
        const record = Schema.decodeUnknownSync(schema)(JSON.parse(line))
        if (!keep(record)) continue
        kept += 1
        const serialized = JSON.stringify(prepare(record))
        changed ||= serialized !== line
        await output.write(`${serialized}\n`)
      }
    } finally {
      await output.close()
      output = null
    }
    if (kept === total && !changed) {
      await fs.unlink(tmp)
      return
    }
    await fs.rename(tmp, file)
  } catch (cause) {
    if (output !== null) {
      await output.close().catch(() => undefined)
    }
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw cause
  }
}

export const ElicitationsLiveBase: Layer.Layer<Elicitations, never, EventStore> = Layer.effect(
  Elicitations,
  Effect.gen(function* () {
    const store = yield* EventStore
    const readRecent = (cwd: string) => collectStream(store.tail(elicitationsStream(cwd), 1_000))
    const readRecentPending = (cwd: string) => collectStream(store.tail(pendingElicitationsStream(cwd), 1_000))
    return Elicitations.of({
      lookup: (cwd, server, tool, signature) =>
        readRecent(cwd).pipe(
          Effect.map((records) => latestMatching(records, cwd, server, tool, signature)),
          Effect.mapError((cause) => new FsError({ op: "elicitations.lookup", path: ledgerPath(cwd), message: String(cause), cause })),
        ),
      record: (cwd, server, tool, signature, action, content) => {
        const rec: ElicitationRecord = { ts: Date.now(), server, tool, signature, action, content, cwd }
        return store.append(elicitationsStream(cwd), rec).pipe(
          Effect.mapError((cause) => new FsError({ op: "elicitations.record", path: ledgerPath(cwd), message: String(cause), cause })),
        )
      },
      recordPending: (sessionId, cwd, server, tool, requestSignature) => {
        const rec: PendingElicitationRecord = { ts: Date.now(), sessionId, cwd, server, tool, requestSignature }
        return store.append(pendingElicitationsStream(cwd), rec).pipe(
          Effect.mapError((cause) => new FsError({ op: "elicitations.recordPending", path: pendingLedgerPath(cwd), message: String(cause), cause })),
        )
      },
      findLatestPending: (sessionId, cwd, server, tool) =>
        readRecentPending(cwd).pipe(
          Effect.map((records) => latestPending(records, sessionId, cwd, server, tool)),
          Effect.mapError((cause) => new FsError({ op: "elicitations.findLatestPending", path: pendingLedgerPath(cwd), message: String(cause), cause })),
        ),
      gc: (cwd, now, maxAgeMs = DEFAULT_GC_MAX_AGE_MS) => Effect.tryPromise({
        try: async () => {
          const file = ledgerPath(cwd)
          const cutoff = now - maxAgeMs
          if (fsSync.existsSync(file)) {
            await withFileLock(file, async () => {
              if (!fsSync.existsSync(file)) return
              await rewriteJsonlLedger(
                file,
                ElicitationRecordSchema,
                (r) => r.cwd !== cwd || r.ts >= cutoff,
                sanitizeElicitationRecord,
              )
            })
          }
          const pendingFile = pendingLedgerPath(cwd)
          if (fsSync.existsSync(pendingFile)) {
            await withFileLock(pendingFile, async () => {
              if (!fsSync.existsSync(pendingFile)) return
              await rewriteJsonlLedger(
                pendingFile,
                PendingElicitationRecordSchema,
                (r) => r.cwd !== cwd || r.ts >= cutoff,
              )
            })
          }
        },
        catch: (cause) => new FsError({ op: "elicitations.gc", path: ledgerPath(cwd), message: String(cause), cause }),
      }),
    })
  }),
)

export const ElicitationsLive: Layer.Layer<Elicitations> = Layer.provide(ElicitationsLiveBase, EventStoreLive)

export const ElicitationsTest = (
  initial: ReadonlyArray<ElicitationRecord> = [],
  initialPending: ReadonlyArray<PendingElicitationRecord> = [],
): Layer.Layer<Elicitations> => Layer.effect(Elicitations, Effect.gen(function* () {
  const ref = yield* Ref.make<ElicitationRecord[]>(initial.map(sanitizeElicitationRecord))
  const pendingRef = yield* Ref.make<PendingElicitationRecord[]>([...initialPending])
  return Elicitations.of({
    lookup: (cwd, server, tool, signature) => Ref.get(ref).pipe(Effect.map((arr) => latestMatching(arr, cwd, server, tool, signature))),
    record: (cwd, server, tool, signature, action, content) =>
      Ref.update(ref, (arr) => [
        ...arr,
        sanitizeElicitationRecord({ ts: Date.now(), server, tool, signature, action, content, cwd }),
      ]),
    recordPending: (sessionId, cwd, server, tool, requestSignature) => Ref.update(pendingRef, (arr) => [...arr, { ts: Date.now(), sessionId, cwd, server, tool, requestSignature }]),
    findLatestPending: (sessionId, cwd, server, tool) => Ref.get(pendingRef).pipe(Effect.map((arr) => latestPending(arr, sessionId, cwd, server, tool))),
    gc: (cwd, now, maxAgeMs = DEFAULT_GC_MAX_AGE_MS) => Effect.all([
      Ref.update(ref, (arr) => { const cutoff = now - maxAgeMs; return arr.filter((r) => r.cwd !== cwd || r.ts >= cutoff) }),
      Ref.update(pendingRef, (arr) => { const cutoff = now - maxAgeMs; return arr.filter((r) => r.cwd !== cwd || r.ts >= cutoff) }),
    ]).pipe(Effect.asVoid),
  })
}))
