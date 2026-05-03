import { Context, Effect, Layer, Ref } from "effect"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as path from "node:path"
import { FsError } from "../schema/errors.ts"

export type ApprovalStatus = "approved" | "denied" | "pending"

export interface ApprovalRecord {
  readonly cwd: string
  readonly pattern: string
  readonly status: ApprovalStatus
  readonly recordedAt: number
}

export interface ApprovalsApi {
  readonly lookup: (
    cwd: string,
    pattern: string,
  ) => Effect.Effect<ApprovalRecord | null, FsError>
  readonly findPending: (
    cwd: string,
    pattern: string,
  ) => Effect.Effect<ApprovalRecord | null, FsError>
  readonly record: (
    record: ApprovalRecord,
  ) => Effect.Effect<void, FsError>
}

export class Approvals extends Context.Tag("Approvals")<Approvals, ApprovalsApi>() {}

const ledgerPath = (cwd: string): string =>
  path.join(cwd, ".claude-hooks", "state", "approvals.jsonl")

const parseLine = (line: string): ApprovalRecord | null => {
  try {
    const v: unknown = JSON.parse(line)
    if (typeof v !== "object" || v === null) return null
    const r = v as { cwd?: unknown; pattern?: unknown; status?: unknown; recordedAt?: unknown }
    if (
      typeof r.cwd !== "string" ||
      typeof r.pattern !== "string" ||
      typeof r.recordedAt !== "number" ||
      (r.status !== "approved" && r.status !== "denied" && r.status !== "pending")
    ) {
      return null
    }
    return {
      cwd: r.cwd,
      pattern: r.pattern,
      status: r.status,
      recordedAt: r.recordedAt,
    }
  } catch {
    return null
  }
}

const readAllRecords = async (file: string): Promise<ApprovalRecord[]> => {
  if (!fsSync.existsSync(file)) return []
  const raw = await fs.readFile(file, "utf8")
  const out: ApprovalRecord[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    const rec = parseLine(line)
    if (rec !== null) out.push(rec)
  }
  return out
}

const latestMatching = (
  records: ReadonlyArray<ApprovalRecord>,
  cwd: string,
  pattern: string,
  predicate: (r: ApprovalRecord) => boolean = () => true,
): ApprovalRecord | null => {
  let latest: ApprovalRecord | null = null
  for (const rec of records) {
    if (rec.cwd !== cwd || rec.pattern !== pattern) continue
    if (!predicate(rec)) continue
    if (latest === null || rec.recordedAt >= latest.recordedAt) latest = rec
  }
  return latest
}

export const ApprovalsLive: Layer.Layer<Approvals> = Layer.succeed(
  Approvals,
  Approvals.of({
    lookup: (cwd, pattern) =>
      Effect.tryPromise({
        try: async () => {
          const file = ledgerPath(cwd)
          const all = await readAllRecords(file)
          // Resolved decisions take precedence over pending entries.
          const resolved = latestMatching(
            all,
            cwd,
            pattern,
            (r) => r.status === "approved" || r.status === "denied",
          )
          if (resolved !== null) return resolved
          return latestMatching(all, cwd, pattern)
        },
        catch: (cause) =>
          new FsError({
            op: "approvals.lookup",
            path: ledgerPath(cwd),
            message: String(cause),
            cause,
          }),
      }),
    findPending: (cwd, pattern) =>
      Effect.tryPromise({
        try: async () => {
          const file = ledgerPath(cwd)
          const all = await readAllRecords(file)
          return latestMatching(all, cwd, pattern, (r) => r.status === "pending")
        },
        catch: (cause) =>
          new FsError({
            op: "approvals.findPending",
            path: ledgerPath(cwd),
            message: String(cause),
            cause,
          }),
      }),
    record: (record) =>
      Effect.tryPromise({
        try: async () => {
          const file = ledgerPath(record.cwd)
          await fs.mkdir(path.dirname(file), { recursive: true })
          await fs.appendFile(file, JSON.stringify(record) + "\n", "utf8")
        },
        catch: (cause) =>
          new FsError({
            op: "approvals.record",
            path: ledgerPath(record.cwd),
            message: String(cause),
            cause,
          }),
      }),
  }),
)

export const ApprovalsTest = (
  initial: ReadonlyArray<ApprovalRecord> = [],
): Layer.Layer<Approvals> =>
  Layer.effect(
    Approvals,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ApprovalRecord[]>([...initial])
      return Approvals.of({
        lookup: (cwd, pattern) =>
          Ref.get(ref).pipe(
            Effect.map((arr) => {
              const resolved = latestMatching(
                arr,
                cwd,
                pattern,
                (r) => r.status === "approved" || r.status === "denied",
              )
              if (resolved !== null) return resolved
              return latestMatching(arr, cwd, pattern)
            }),
          ),
        findPending: (cwd, pattern) =>
          Ref.get(ref).pipe(
            Effect.map((arr) =>
              latestMatching(arr, cwd, pattern, (r) => r.status === "pending"),
            ),
          ),
        record: (rec) =>
          Ref.update(ref, (arr) => [...arr, rec]),
      })
    }),
  )
