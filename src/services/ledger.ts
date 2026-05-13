import { Context, Effect, Layer, Ref } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { LedgerError } from "../schema/errors.ts";
import { eventStream, LedgerEntrySchema } from "../schema/events.ts";
import { collectStream, EventStore, EventStoreLive } from "./event-store.ts";

export interface LedgerEntry {
  readonly timestamp: number;
  readonly event: string;
  readonly sessionId: string;
  readonly data: unknown;
}

export interface LedgerApi {
  readonly append: (entry: LedgerEntry) => Effect.Effect<void, LedgerError>;
  readonly read: (
    sessionId?: string,
  ) => Effect.Effect<ReadonlyArray<LedgerEntry>, LedgerError>;
}

export class Ledger extends Context.Tag("Ledger")<Ledger, LedgerApi>() {}

const sessionDir = (root: string, sessionId: string) =>
  path.join(root, ".claude-hooks", "state", sessionId);

const ledgerPath = (root: string, sessionId: string) =>
  path.join(sessionDir(root, sessionId), "ledger.jsonl");

const stateRoot = (root: string) => path.join(root, ".claude-hooks", "state");

const ledgerStream = (root: string, sessionId: string) =>
  eventStream(`session-ledger:${sessionId}`, ledgerPath(root, sessionId), LedgerEntrySchema, {
    maxRecords: 1_000,
  });

const isNodeErrorCode = (cause: unknown, code: string): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { code?: unknown }).code === code;

const isDirectory = (filePath: string): Effect.Effect<boolean, LedgerError> =>
  Effect.tryPromise({
    try: async () => (await fs.stat(filePath)).isDirectory(),
    catch: (cause) => new LedgerError({ op: "read", message: String(cause), cause }),
  }).pipe(
    Effect.catchIf((err) => isNodeErrorCode(err.cause, "ENOENT"), () => Effect.succeed(false)),
  );

export const LedgerLiveBase = (root: string = process.cwd()): Layer.Layer<Ledger, never, EventStore> =>
  Layer.effect(
    Ledger,
    Effect.gen(function* () {
      const store = yield* EventStore
      const readSession = (sessionId: string) => collectStream(store.tail(ledgerStream(root, sessionId), 1_000))
      return Ledger.of({
        append: (entry) =>
          store.append(ledgerStream(root, entry.sessionId), entry).pipe(
            Effect.mapError((cause) =>
              new LedgerError({ op: "append", message: String(cause), cause }),
            ),
          ),
        read: (sessionId) =>
          Effect.gen(function* () {
            if (sessionId !== undefined) {
              return yield* readSession(sessionId).pipe(
                Effect.mapError((cause) => new LedgerError({ op: "read", message: String(cause), cause })),
              );
            }
            // Aggregate across every session directory under state/.
            const dirs = yield* Effect.tryPromise({
              try: () => fs.readdir(stateRoot(root)),
              catch: (cause) => new LedgerError({ op: "read", message: String(cause), cause }),
            }).pipe(Effect.catchIf((err) => isNodeErrorCode(err.cause, "ENOENT"), () => Effect.succeed([] as string[])));
            const all: LedgerEntry[] = [];
            for (const d of dirs) {
              const maybeSessionDir = yield* isDirectory(path.join(stateRoot(root), d));
              if (!maybeSessionDir) continue;
              all.push(...(yield* readSession(d).pipe(
                Effect.mapError((cause) => new LedgerError({ op: "read", message: String(cause), cause })),
              )));
            }
            return all;
          }),
      })
    }),
  );

export const LedgerLive = (root: string = process.cwd()): Layer.Layer<Ledger> =>
  Layer.provide(LedgerLiveBase(root), EventStoreLive)

export const LedgerTest = (): Layer.Layer<Ledger> =>
  Layer.effect(
    Ledger,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ReadonlyArray<LedgerEntry>>([]);
      return Ledger.of({
        append: (entry) => Ref.update(ref, (xs) => [...xs, entry]),
        read: (sessionId) =>
          Ref.get(ref).pipe(
            Effect.map((xs) =>
              sessionId ? xs.filter((e) => e.sessionId === sessionId) : xs,
            ),
          ),
      });
    }),
  );
