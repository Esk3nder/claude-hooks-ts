import { Context, Effect, Layer, Ref } from "effect"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as path from "node:path"
import { FsError } from "../schema/errors.ts"

export type ApprovalStatus = "approved" | "denied"

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
      (r.status !== "approved" && r.status !== "denied")
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

export const ApprovalsLive: Layer.Layer<Approvals> = Layer.succeed(
  Approvals,
  Approvals.of({
    lookup: (cwd, pattern) =>
      Effect.tryPromise({
        try: async () => {
          const file = ledgerPath(cwd)
          if (!fsSync.existsSync(file)) return null
          const raw = await fs.readFile(file, "utf8")
          let latest: ApprovalRecord | null = null
          for (const line of raw.split(/\r?\n/)) {
            if (line.trim().length === 0) continue
            const rec = parseLine(line)
            if (rec === null) continue
            if (rec.cwd === cwd && rec.pattern === pattern) {
              if (latest === null || rec.recordedAt >= latest.recordedAt) {
                latest = rec
              }
            }
          }
          return latest
        },
        catch: (cause) =>
          new FsError({
            op: "approvals.lookup",
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
              let latest: ApprovalRecord | null = null
              for (const r of arr) {
                if (r.cwd === cwd && r.pattern === pattern) {
                  if (latest === null || r.recordedAt >= latest.recordedAt) {
                    latest = r
                  }
                }
              }
              return latest
            }),
          ),
        record: (rec) =>
          Ref.update(ref, (arr) => [...arr, rec]),
      })
    }),
  )
