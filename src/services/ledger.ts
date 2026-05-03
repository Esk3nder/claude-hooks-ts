import { Context, Effect, Layer, Ref } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { LedgerError } from "../schema/errors.ts";
import { withFileLock } from "./file-lock.ts";

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

const ledgerPath = (root: string) => path.join(root, ".claude", "ledger.jsonl");

export const LedgerLive = (root: string = process.cwd()): Layer.Layer<Ledger> =>
  Layer.succeed(
    Ledger,
    Ledger.of({
      append: (entry) =>
        Effect.tryPromise({
          try: async () => {
            const file = ledgerPath(root);
            await fs.mkdir(path.dirname(file), { recursive: true });
            await withFileLock(file, async () => {
              await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
            });
          },
          catch: (cause) =>
            new LedgerError({ op: "append", message: String(cause), cause }),
        }),
      read: (sessionId) =>
        Effect.tryPromise({
          try: async () => {
            const file = ledgerPath(root);
            try {
              const raw = await fs.readFile(file, "utf8");
              const lines = raw.split("\n").filter((l) => l.length > 0);
              const entries = lines
                .map((l) => JSON.parse(l) as LedgerEntry)
                .filter((e) => !sessionId || e.sessionId === sessionId);
              return entries;
            } catch {
              return [];
            }
          },
          catch: (cause) =>
            new LedgerError({ op: "read", message: String(cause), cause }),
        }),
    }),
  );

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
