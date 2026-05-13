import { Context, Effect, Layer, Ref, Schema } from "effect";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { FsError } from "../schema/errors.ts";
import { ApprovalRecordSchema, eventStream } from "../schema/events.ts";
import { collectStream, EventStore, EventStoreLive, summarizeEventStoreError } from "./event-store.ts";
import { withFileLock } from "./file-lock.ts";

export type ApprovalStatus = "approved" | "denied" | "pending";

export interface ApprovalRecord {
  readonly cwd: string;
  readonly pattern: string;
  readonly status: ApprovalStatus;
  readonly recordedAt: number;
}

export const DEFAULT_GC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const GC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * True if more than `GC_INTERVAL_MS` (24h) has elapsed since the last gc run.
 * Pure helper — easy to unit test, no Schedule needed.
 */
export const shouldGc = (
  now: number,
  lastGc: number,
  intervalMs: number = GC_INTERVAL_MS,
): boolean => now - lastGc > intervalMs;

export interface ApprovalsApi {
  readonly lookup: (
    cwd: string,
    pattern: string,
  ) => Effect.Effect<ApprovalRecord | null, FsError>;
  readonly findPending: (
    cwd: string,
    pattern: string,
  ) => Effect.Effect<ApprovalRecord | null, FsError>;
  readonly record: (record: ApprovalRecord) => Effect.Effect<void, FsError>;
  /**
   * Remove approval-ledger entries older than `maxAgeMs` (default 7 days)
   * for the given `cwd`, then update the meta file's `last_gc` timestamp.
   */
  readonly gc: (
    cwd: string,
    now: number,
    maxAgeMs?: number,
  ) => Effect.Effect<void, FsError>;
}

export class Approvals extends Context.Tag("Approvals")<
  Approvals,
  ApprovalsApi
>() {}

const ledgerPath = (cwd: string): string =>
  path.join(cwd, ".claude-hooks", "state", "approvals.jsonl");

const metaPath = (cwd: string): string =>
  path.join(cwd, ".claude-hooks", "state", "approvals-meta.json");

const approvalsStream = (cwd: string) =>
  eventStream(`approvals:${cwd}`, ledgerPath(cwd), ApprovalRecordSchema, {
    maxRecords: 1_000,
  });

const latestMatching = (
  records: ReadonlyArray<ApprovalRecord>,
  cwd: string,
  pattern: string,
  predicate: (r: ApprovalRecord) => boolean = () => true,
): ApprovalRecord | null => {
  let latest: ApprovalRecord | null = null;
  for (const rec of records) {
    if (rec.cwd !== cwd || rec.pattern !== pattern) continue;
    if (!predicate(rec)) continue;
    if (latest === null || rec.recordedAt >= latest.recordedAt) latest = rec;
  }
  return latest;
};

const writeMeta = async (file: string, lastGc: number): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ last_gc: lastGc }) + "\n", "utf8");
};

const eventStoreFsError = (op: string, file: string, cause: unknown): FsError => {
  const summary = summarizeEventStoreError(cause);
  return new FsError({
    op,
    path: file,
    message: summary,
    cause: summary,
  });
};

const rewriteApprovalLedger = async (
  file: string,
  keep: (record: ApprovalRecord) => boolean,
): Promise<void> => {
  const tmp = `${file}.${process.pid}.${Date.now()}.gc.tmp`;
  let total = 0;
  let kept = 0;
  let output: fs.FileHandle | null = null;
  try {
    const input = fsSync.createReadStream(file, { encoding: "utf8" });
    output = await fs.open(tmp, "wx");
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.trim().length === 0) continue;
        total += 1;
        const record = Schema.decodeUnknownSync(ApprovalRecordSchema)(JSON.parse(line));
        if (!keep(record)) continue;
        kept += 1;
        await output.write(`${JSON.stringify(record)}\n`);
      }
    } finally {
      await output.close();
      output = null;
    }
    if (kept === total) {
      await fs.unlink(tmp);
      return;
    }
    await fs.rename(tmp, file);
  } catch (cause) {
    if (output !== null) {
      await output.close().catch(() => undefined);
    }
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw cause;
  }
};

export const ApprovalsLiveBase: Layer.Layer<Approvals, never, EventStore> = Layer.effect(
  Approvals,
  Effect.gen(function* () {
    const store = yield* EventStore
    const readRecent = (cwd: string) => collectStream(store.tail(approvalsStream(cwd), 1_000))
    return Approvals.of({
      lookup: (cwd, pattern) =>
        readRecent(cwd).pipe(
          Effect.map((all) => {
            // Resolved decisions take precedence over pending entries.
            const resolved = latestMatching(
              all,
              cwd,
              pattern,
              (r) => r.status === "approved" || r.status === "denied",
            );
            if (resolved !== null) return resolved;
            return latestMatching(all, cwd, pattern);
          }),
          Effect.mapError((cause) => eventStoreFsError("approvals.lookup", ledgerPath(cwd), cause)),
        ),
      findPending: (cwd, pattern) =>
        readRecent(cwd).pipe(
          Effect.map((all) =>
            latestMatching(
              all,
              cwd,
              pattern,
              (r) => r.status === "pending",
            )
          ),
          Effect.mapError((cause) => eventStoreFsError("approvals.findPending", ledgerPath(cwd), cause)),
        ),
      record: (record) =>
        store.append(approvalsStream(record.cwd), record).pipe(
          Effect.mapError((cause) => eventStoreFsError("approvals.record", ledgerPath(record.cwd), cause)),
        ),
      gc: (cwd, now, maxAgeMs = DEFAULT_GC_MAX_AGE_MS) =>
        Effect.tryPromise({
          try: async () => {
            const file = ledgerPath(cwd);
            // No ledger → nothing to gc; just record the gc timestamp.
            if (!fsSync.existsSync(file)) {
              await writeMeta(metaPath(cwd), now);
              return;
            }
            await withFileLock(file, async () => {
              if (!fsSync.existsSync(file)) return;
              const cutoff = now - maxAgeMs;
              await rewriteApprovalLedger(file, (r) => r.cwd !== cwd || r.recordedAt >= cutoff);
            });
            await writeMeta(metaPath(cwd), now);
          },
          catch: (cause) =>
            new FsError({
              op: "approvals.gc",
              path: ledgerPath(cwd),
              message: String(cause),
              cause,
            }),
        }),
    })
  }),
);

export const ApprovalsLive: Layer.Layer<Approvals> = Layer.provide(ApprovalsLiveBase, EventStoreLive)

export const ApprovalsTest = (
  initial: ReadonlyArray<ApprovalRecord> = [],
): Layer.Layer<Approvals> =>
  Layer.effect(
    Approvals,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ApprovalRecord[]>([...initial]);
      const meta = yield* Ref.make<{ last_gc: number }>({ last_gc: 0 });
      return Approvals.of({
        lookup: (cwd, pattern) =>
          Ref.get(ref).pipe(
            Effect.map((arr) => {
              const resolved = latestMatching(
                arr,
                cwd,
                pattern,
                (r) => r.status === "approved" || r.status === "denied",
              );
              if (resolved !== null) return resolved;
              return latestMatching(arr, cwd, pattern);
            }),
          ),
        findPending: (cwd, pattern) =>
          Ref.get(ref).pipe(
            Effect.map((arr) =>
              latestMatching(arr, cwd, pattern, (r) => r.status === "pending"),
            ),
          ),
        record: (rec) => Ref.update(ref, (arr) => [...arr, rec]),
        gc: (cwd, now, maxAgeMs = DEFAULT_GC_MAX_AGE_MS) =>
          Effect.gen(function* () {
            const cutoff = now - maxAgeMs;
            yield* Ref.update(ref, (arr) =>
              arr.filter((r) => r.cwd !== cwd || r.recordedAt >= cutoff),
            );
            yield* Ref.set(meta, { last_gc: now });
          }),
      });
    }),
  );
