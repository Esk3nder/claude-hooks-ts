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

const sessionDir = (root: string, sessionId: string) =>
  path.join(root, ".claude-hooks", "state", sessionId);

const ledgerPath = (root: string, sessionId: string) =>
  path.join(sessionDir(root, sessionId), "ledger.jsonl");

const stateRoot = (root: string) => path.join(root, ".claude-hooks", "state");

const parseLines = (raw: string): LedgerEntry[] => {
  const entries: LedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
    } catch (err) {
      process.stderr.write(
        `ledger.read: skipping malformed line: ${String(err).slice(0, 120)}\n`,
      );
    }
  }
  return entries;
};

const readSessionFile = async (file: string): Promise<LedgerEntry[]> => {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      return [];
    }
    throw err;
  }
  return parseLines(raw);
};

export const LedgerLive = (root: string = process.cwd()): Layer.Layer<Ledger> =>
  Layer.succeed(
    Ledger,
    Ledger.of({
      append: (entry) =>
        Effect.tryPromise({
          try: async () => {
            const file = ledgerPath(root, entry.sessionId);
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
            if (sessionId !== undefined) {
              return await readSessionFile(ledgerPath(root, sessionId));
            }
            // Aggregate across every session directory under state/.
            let dirs: string[] = [];
            try {
              dirs = await fs.readdir(stateRoot(root));
            } catch (err) {
              if (
                typeof err === "object" &&
                err !== null &&
                (err as { code?: string }).code === "ENOENT"
              ) {
                return [];
              }
              throw err;
            }
            const all: LedgerEntry[] = [];
            for (const d of dirs) {
              const file = path.join(stateRoot(root), d, "ledger.jsonl");
              all.push(...(await readSessionFile(file)));
            }
            return all;
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
