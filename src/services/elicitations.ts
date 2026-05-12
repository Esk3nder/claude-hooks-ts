import { Context, Effect, Layer, Ref } from "effect"
import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as path from "node:path"
import { FsError } from "../schema/errors.ts"
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

const parseLine = (line: string): ElicitationRecord | null => {
  try {
    const v: unknown = JSON.parse(line)
    if (typeof v !== "object" || v === null) return null
    const r = v as { ts?: unknown; server?: unknown; tool?: unknown; signature?: unknown; action?: unknown; content?: unknown; cwd?: unknown }
    if (typeof r.ts !== "number" || typeof r.server !== "string" || typeof r.tool !== "string" || typeof r.signature !== "string" || typeof r.cwd !== "string" || (r.action !== "accept" && r.action !== "decline" && r.action !== "cancel")) return null
    return { ts: r.ts, server: r.server, tool: r.tool, signature: r.signature, action: r.action, content: r.content, cwd: r.cwd }
  } catch { return null }
}

const readAllRecords = async (file: string): Promise<ElicitationRecord[]> => {
  if (!fsSync.existsSync(file)) return []
  const raw = await fs.readFile(file, "utf8")
  const out: ElicitationRecord[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    const rec = parseLine(line)
    if (rec !== null) out.push(rec)
  }
  return out
}

const parsePendingLine = (line: string): PendingElicitationRecord | null => {
  try {
    const v: unknown = JSON.parse(line)
    if (typeof v !== "object" || v === null) return null
    const r = v as { ts?: unknown; sessionId?: unknown; cwd?: unknown; server?: unknown; tool?: unknown; requestSignature?: unknown }
    if (
      typeof r.ts !== "number" ||
      typeof r.sessionId !== "string" ||
      typeof r.cwd !== "string" ||
      typeof r.server !== "string" ||
      typeof r.tool !== "string" ||
      typeof r.requestSignature !== "string"
    ) return null
    return {
      ts: r.ts,
      sessionId: r.sessionId,
      cwd: r.cwd,
      server: r.server,
      tool: r.tool,
      requestSignature: r.requestSignature,
    }
  } catch { return null }
}

const readAllPending = async (file: string): Promise<PendingElicitationRecord[]> => {
  if (!fsSync.existsSync(file)) return []
  const raw = await fs.readFile(file, "utf8")
  const out: PendingElicitationRecord[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    const rec = parsePendingLine(line)
    if (rec !== null) out.push(rec)
  }
  return out
}

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

export const ElicitationsLive: Layer.Layer<Elicitations> = Layer.succeed(Elicitations, Elicitations.of({
  lookup: (cwd, server, tool, signature) => Effect.tryPromise({
    try: async () => latestMatching(await readAllRecords(ledgerPath(cwd)), cwd, server, tool, signature),
    catch: (cause) => new FsError({ op: "elicitations.lookup", path: ledgerPath(cwd), message: String(cause), cause }),
  }),
  record: (cwd, server, tool, signature, action, content) => Effect.tryPromise({
    try: async () => {
      const file = ledgerPath(cwd)
      await fs.mkdir(path.dirname(file), { recursive: true })
      const rec: ElicitationRecord = { ts: Date.now(), server, tool, signature, action, content, cwd }
      await withFileLock(file, async () => { await fs.appendFile(file, JSON.stringify(rec) + "\n", "utf8") })
    },
    catch: (cause) => new FsError({ op: "elicitations.record", path: ledgerPath(cwd), message: String(cause), cause }),
  }),
  recordPending: (sessionId, cwd, server, tool, requestSignature) => Effect.tryPromise({
    try: async () => {
      const file = pendingLedgerPath(cwd)
      await fs.mkdir(path.dirname(file), { recursive: true })
      const rec: PendingElicitationRecord = { ts: Date.now(), sessionId, cwd, server, tool, requestSignature }
      await withFileLock(file, async () => { await fs.appendFile(file, JSON.stringify(rec) + "\n", "utf8") })
    },
    catch: (cause) => new FsError({ op: "elicitations.recordPending", path: pendingLedgerPath(cwd), message: String(cause), cause }),
  }),
  findLatestPending: (sessionId, cwd, server, tool) => Effect.tryPromise({
    try: async () => latestPending(await readAllPending(pendingLedgerPath(cwd)), sessionId, cwd, server, tool),
    catch: (cause) => new FsError({ op: "elicitations.findLatestPending", path: pendingLedgerPath(cwd), message: String(cause), cause }),
  }),
  gc: (cwd, now, maxAgeMs = DEFAULT_GC_MAX_AGE_MS) => Effect.tryPromise({
    try: async () => {
      const file = ledgerPath(cwd)
      const cutoff = now - maxAgeMs
      if (fsSync.existsSync(file)) {
        await withFileLock(file, async () => {
          const all = await readAllRecords(file)
          const kept = all.filter((r) => r.cwd !== cwd || r.ts >= cutoff)
          if (kept.length !== all.length) {
            await fs.mkdir(path.dirname(file), { recursive: true })
            const body = kept.map((r) => JSON.stringify(r)).join("\n")
            await fs.writeFile(file, body.length === 0 ? "" : body + "\n", "utf8")
          }
        })
      }
      const pendingFile = pendingLedgerPath(cwd)
      if (fsSync.existsSync(pendingFile)) {
        await withFileLock(pendingFile, async () => {
          const all = await readAllPending(pendingFile)
          const kept = all.filter((r) => r.cwd !== cwd || r.ts >= cutoff)
          if (kept.length !== all.length) {
            await fs.mkdir(path.dirname(pendingFile), { recursive: true })
            const body = kept.map((r) => JSON.stringify(r)).join("\n")
            await fs.writeFile(pendingFile, body.length === 0 ? "" : body + "\n", "utf8")
          }
        })
      }
    },
    catch: (cause) => new FsError({ op: "elicitations.gc", path: ledgerPath(cwd), message: String(cause), cause }),
  }),
}))

export const ElicitationsTest = (
  initial: ReadonlyArray<ElicitationRecord> = [],
  initialPending: ReadonlyArray<PendingElicitationRecord> = [],
): Layer.Layer<Elicitations> => Layer.effect(Elicitations, Effect.gen(function* () {
  const ref = yield* Ref.make<ElicitationRecord[]>([...initial])
  const pendingRef = yield* Ref.make<PendingElicitationRecord[]>([...initialPending])
  return Elicitations.of({
    lookup: (cwd, server, tool, signature) => Ref.get(ref).pipe(Effect.map((arr) => latestMatching(arr, cwd, server, tool, signature))),
    record: (cwd, server, tool, signature, action, content) => Ref.update(ref, (arr) => [...arr, { ts: Date.now(), server, tool, signature, action, content, cwd }]),
    recordPending: (sessionId, cwd, server, tool, requestSignature) => Ref.update(pendingRef, (arr) => [...arr, { ts: Date.now(), sessionId, cwd, server, tool, requestSignature }]),
    findLatestPending: (sessionId, cwd, server, tool) => Ref.get(pendingRef).pipe(Effect.map((arr) => latestPending(arr, sessionId, cwd, server, tool))),
    gc: (cwd, now, maxAgeMs = DEFAULT_GC_MAX_AGE_MS) => Effect.all([
      Ref.update(ref, (arr) => { const cutoff = now - maxAgeMs; return arr.filter((r) => r.cwd !== cwd || r.ts >= cutoff) }),
      Ref.update(pendingRef, (arr) => { const cutoff = now - maxAgeMs; return arr.filter((r) => r.cwd !== cwd || r.ts >= cutoff) }),
    ]).pipe(Effect.asVoid),
  })
}))
