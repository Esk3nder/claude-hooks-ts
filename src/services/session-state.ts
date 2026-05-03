import { Context, Effect, Layer, Ref, Schema } from "effect";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { FsError } from "../schema/errors.ts";
import { SessionStateRecordSchema } from "../schema/session-state.ts";
import { getCurrentSession } from "./session-context.ts";
import { withFileLock } from "./file-lock.ts";

export type VerificationStatus = "passed" | "failed" | "none";

export interface SessionStateRecord {
  readonly files_read: ReadonlyArray<string>;
  readonly files_changed: ReadonlyArray<string>;
  readonly commands_run: ReadonlyArray<string>;
  readonly commands_failed: ReadonlyArray<string>;
  readonly tests_run: ReadonlyArray<string>;
  readonly verification_status: VerificationStatus;
  readonly next_required_action: string | null;
  readonly stop_blocked_once: boolean;
  readonly source_urls: ReadonlyArray<string>;
  readonly subagent_starts: ReadonlyArray<string>;
  readonly subagent_stops: ReadonlyArray<string>;
  readonly last_workflow: string | null;
}

export const EMPTY_SESSION_STATE: SessionStateRecord = {
  files_read: [],
  files_changed: [],
  commands_run: [],
  commands_failed: [],
  tests_run: [],
  verification_status: "none",
  next_required_action: null,
  stop_blocked_once: false,
  source_urls: [],
  subagent_starts: [],
  subagent_stops: [],
  last_workflow: null,
};

export type AppendableKey =
  | "files_read"
  | "files_changed"
  | "commands_run"
  | "commands_failed"
  | "tests_run"
  | "source_urls"
  | "subagent_starts"
  | "subagent_stops";

/**
 * SessionState API. Each method has two forms:
 *   1. Explicit `sessionId: string` — for direct test use / when the caller
 *      already has the id in scope.
 *   2. Omitted — reads the current session from the {@link currentSessionId}
 *      FiberRef set by `withSession` at the dispatcher entry point.
 */
export interface SessionStateApi {
  readonly get: {
    (sessionId: string): Effect.Effect<SessionStateRecord, FsError>;
    (): Effect.Effect<SessionStateRecord, FsError>;
  };
  readonly update: {
    (
      sessionId: string,
      patch: Partial<SessionStateRecord>,
    ): Effect.Effect<void, FsError>;
    (patch: Partial<SessionStateRecord>): Effect.Effect<void, FsError>;
  };
  readonly append: {
    (
      sessionId: string,
      key: AppendableKey,
      value: string,
    ): Effect.Effect<void, FsError>;
    (key: AppendableKey, value: string): Effect.Effect<void, FsError>;
  };
  readonly appendBatch: {
    (
      sessionId: string,
      entries: ReadonlyArray<{
        readonly key: AppendableKey;
        readonly value: string;
      }>,
    ): Effect.Effect<void, FsError>;
    (
      entries: ReadonlyArray<{
        readonly key: AppendableKey;
        readonly value: string;
      }>,
    ): Effect.Effect<void, FsError>;
  };
}

export class SessionState extends Context.Tag("SessionState")<
  SessionState,
  SessionStateApi
>() {}

const statePath = (root: string, sessionId: string): string =>
  path.join(root, ".claude-hooks", "state", `${sessionId}.json`);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isStringArray = (v: unknown): v is ReadonlyArray<string> =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

const decodeStrict = Schema.decodeUnknownEither(SessionStateRecordSchema);

/**
 * Strict schema-validated read. On schema mismatch:
 *   1. write the raw bytes to a `<file>.corrupt-<ts>.bak` sibling for forensics
 *   2. emit a stderr warning
 *   3. return EMPTY_SESSION_STATE (callers should treat as fresh)
 *
 * Returns null only when the input is not even valid JSON, so the lenient
 * fallback can take over (we keep it for back-compat with files written by
 * older builds that allowed missing fields).
 */
const parseRecordStrict = (
  raw: string,
  filePath: string,
  sessionId: string,
): SessionStateRecord | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const decoded = decodeStrict(parsed);
  if (decoded._tag === "Right") {
    return decoded.right as SessionStateRecord;
  }
  try {
    const bak = `${filePath}.corrupt-${Date.now()}.bak`;
    fsSync.mkdirSync(path.dirname(bak), { recursive: true });
    fsSync.writeFileSync(bak, raw, "utf8");
  } catch {
    // best-effort
  }
  process.stderr.write(
    `session-state: schema mismatch for ${sessionId}, resetting\n`,
  );
  return EMPTY_SESSION_STATE;
};

const parseRecord = (raw: string): SessionStateRecord => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return EMPTY_SESSION_STATE;
    const get = (k: string): unknown => parsed[k];
    const filesRead = get("files_read");
    const filesChanged = get("files_changed");
    const commandsRun = get("commands_run");
    const commandsFailed = get("commands_failed");
    const testsRun = get("tests_run");
    const verification = get("verification_status");
    const next = get("next_required_action");
    const stopBlocked = get("stop_blocked_once");
    const sourceUrls = get("source_urls");
    return {
      files_read: isStringArray(filesRead) ? filesRead : [],
      files_changed: isStringArray(filesChanged) ? filesChanged : [],
      commands_run: isStringArray(commandsRun) ? commandsRun : [],
      commands_failed: isStringArray(commandsFailed) ? commandsFailed : [],
      tests_run: isStringArray(testsRun) ? testsRun : [],
      verification_status:
        verification === "passed" || verification === "failed"
          ? verification
          : "none",
      next_required_action: typeof next === "string" ? next : null,
      stop_blocked_once: stopBlocked === true,
      source_urls: isStringArray(sourceUrls) ? sourceUrls : [],
      subagent_starts: isStringArray(get("subagent_starts"))
        ? (get("subagent_starts") as ReadonlyArray<string>)
        : [],
      subagent_stops: isStringArray(get("subagent_stops"))
        ? (get("subagent_stops") as ReadonlyArray<string>)
        : [],
      last_workflow:
        typeof get("last_workflow") === "string"
          ? (get("last_workflow") as string)
          : null,
    };
  } catch {
    return EMPTY_SESSION_STATE;
  }
};

const mergePatch = (
  prev: SessionStateRecord,
  patch: Partial<SessionStateRecord>,
): SessionStateRecord => ({
  ...prev,
  ...patch,
});

/**
 * Resolve a sessionId from either an explicit argument or the
 * `currentSessionId` FiberRef. Fails with `FsError` if neither is available.
 */
const resolveSessionId = (
  explicit: string | undefined,
): Effect.Effect<string, FsError> =>
  explicit !== undefined
    ? Effect.succeed(explicit)
    : Effect.flatMap(getCurrentSession(), (sid) =>
        sid === null
          ? Effect.fail(
              new FsError({
                op: "session-state.resolve",
                path: "<no-session>",
                message:
                  "no current session in FiberRef and no explicit sessionId",
              }),
            )
          : Effect.succeed(sid),
      );

export const SessionStateLive = (
  root: string = process.cwd(),
): Layer.Layer<SessionState> =>
  Layer.succeed(
    SessionState,
    SessionState.of({
      get: ((...args: ReadonlyArray<unknown>) => {
        const explicit =
          typeof args[0] === "string" ? (args[0] as string) : undefined;
        return resolveSessionId(explicit).pipe(
          Effect.flatMap((sessionId) =>
            Effect.tryPromise({
              try: async () => {
                const file = statePath(root, sessionId);
                try {
                  const raw = await fs.readFile(file, "utf8");
                  const strict = parseRecordStrict(raw, file, sessionId);
                  if (strict !== null) return strict;
                  // Not JSON at all → treat as empty (parity with old behaviour).
                  return EMPTY_SESSION_STATE;
                } catch {
                  return EMPTY_SESSION_STATE;
                }
              },
              catch: (cause) =>
                new FsError({
                  op: "session-state.get",
                  path: statePath(root, sessionId),
                  message: String(cause),
                  cause,
                }),
            }),
          ),
        );
      }) as SessionStateApi["get"],
      update: ((...args: ReadonlyArray<unknown>) => {
        const explicit =
          typeof args[0] === "string" ? (args[0] as string) : undefined;
        const patch = (
          explicit !== undefined ? args[1] : args[0]
        ) as Partial<SessionStateRecord>;
        return resolveSessionId(explicit).pipe(
          Effect.flatMap((sessionId) =>
            Effect.tryPromise({
              try: async () => {
                const file = statePath(root, sessionId);
                await fs.mkdir(path.dirname(file), { recursive: true });
                await withFileLock(file, async () => {
                  let prev: SessionStateRecord = EMPTY_SESSION_STATE;
                  if (fsSync.existsSync(file)) {
                    const raw = await fs.readFile(file, "utf8");
                    prev = parseRecord(raw);
                  }
                  const next = mergePatch(prev, patch);
                  await fs.writeFile(
                    file,
                    JSON.stringify(next, null, 2),
                    "utf8",
                  );
                });
              },
              catch: (cause) =>
                new FsError({
                  op: "session-state.update",
                  path: statePath(root, sessionId),
                  message: String(cause),
                  cause,
                }),
            }),
          ),
        );
      }) as SessionStateApi["update"],
      append: ((...args: ReadonlyArray<unknown>) => {
        const explicit =
          typeof args[0] === "string" && args.length === 3
            ? (args[0] as string)
            : undefined;
        const key = (
          explicit !== undefined ? args[1] : args[0]
        ) as AppendableKey;
        const value = (explicit !== undefined ? args[2] : args[1]) as string;
        const entries = [{ key, value }] as const;
        return resolveSessionId(explicit).pipe(
          Effect.flatMap((sessionId) =>
            appendBatchLive(root, sessionId, entries),
          ),
        );
      }) as SessionStateApi["append"],
      appendBatch: ((...args: ReadonlyArray<unknown>) => {
        const explicit =
          typeof args[0] === "string" && args.length === 2
            ? (args[0] as string)
            : undefined;
        const entries = (
          explicit !== undefined ? args[1] : args[0]
        ) as ReadonlyArray<{
          readonly key: AppendableKey;
          readonly value: string;
        }>;
        return resolveSessionId(explicit).pipe(
          Effect.flatMap((sessionId) =>
            appendBatchLive(root, sessionId, entries),
          ),
        );
      }) as SessionStateApi["appendBatch"],
    }),
  );

const appendBatchLive = (
  root: string,
  sessionId: string,
  entries: ReadonlyArray<{
    readonly key: AppendableKey;
    readonly value: string;
  }>,
): Effect.Effect<void, FsError> =>
  Effect.tryPromise({
    try: async () => {
      if (entries.length === 0) return;
      const file = statePath(root, sessionId);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await withFileLock(file, async () => {
        let prev: SessionStateRecord = EMPTY_SESSION_STATE;
        if (fsSync.existsSync(file)) {
          const raw = await fs.readFile(file, "utf8");
          prev = parseRecord(raw);
        }
        let next: SessionStateRecord = prev;
        for (const { key, value } of entries) {
          const arr = next[key];
          if (arr.includes(value)) continue;
          next = { ...next, [key]: [...arr, value] };
        }
        if (next === prev) return;
        await fs.writeFile(file, JSON.stringify(next, null, 2), "utf8");
      });
    },
    catch: (cause) =>
      new FsError({
        op: "session-state.appendBatch",
        path: statePath(root, sessionId),
        message: String(cause),
        cause,
      }),
  });

export const SessionStateTest = (
  initial: ReadonlyMap<string, SessionStateRecord> = new Map(),
): Layer.Layer<SessionState> =>
  Layer.effect(
    SessionState,
    Effect.gen(function* () {
      const ref = yield* Ref.make<Map<string, SessionStateRecord>>(
        new Map(initial),
      );
      return SessionState.of({
        get: ((...args: ReadonlyArray<unknown>) => {
          const explicit =
            typeof args[0] === "string" ? (args[0] as string) : undefined;
          return resolveSessionId(explicit).pipe(
            Effect.flatMap((sessionId) =>
              Ref.get(ref).pipe(
                Effect.map((m) => m.get(sessionId) ?? EMPTY_SESSION_STATE),
              ),
            ),
          );
        }) as SessionStateApi["get"],
        update: ((...args: ReadonlyArray<unknown>) => {
          const explicit =
            typeof args[0] === "string" ? (args[0] as string) : undefined;
          const patch = (
            explicit !== undefined ? args[1] : args[0]
          ) as Partial<SessionStateRecord>;
          return resolveSessionId(explicit).pipe(
            Effect.flatMap((sessionId) =>
              Ref.update(ref, (m) => {
                const prev = m.get(sessionId) ?? EMPTY_SESSION_STATE;
                const next = mergePatch(prev, patch);
                const out = new Map(m);
                out.set(sessionId, next);
                return out;
              }),
            ),
          );
        }) as SessionStateApi["update"],
        append: ((...args: ReadonlyArray<unknown>) => {
          const explicit =
            typeof args[0] === "string" && args.length === 3
              ? (args[0] as string)
              : undefined;
          const key = (
            explicit !== undefined ? args[1] : args[0]
          ) as AppendableKey;
          const value = (explicit !== undefined ? args[2] : args[1]) as string;
          return resolveSessionId(explicit).pipe(
            Effect.flatMap((sessionId) =>
              Ref.update(ref, (m) => {
                const prev = m.get(sessionId) ?? EMPTY_SESSION_STATE;
                const arr = prev[key];
                const nextArr = arr.includes(value) ? arr : [...arr, value];
                const next: SessionStateRecord = { ...prev, [key]: nextArr };
                const out = new Map(m);
                out.set(sessionId, next);
                return out;
              }),
            ),
          );
        }) as SessionStateApi["append"],
        appendBatch: ((...args: ReadonlyArray<unknown>) => {
          const explicit =
            typeof args[0] === "string" && args.length === 2
              ? (args[0] as string)
              : undefined;
          const entries = (
            explicit !== undefined ? args[1] : args[0]
          ) as ReadonlyArray<{
            readonly key: AppendableKey;
            readonly value: string;
          }>;
          return resolveSessionId(explicit).pipe(
            Effect.flatMap((sessionId) =>
              Ref.update(ref, (m) => {
                let next = m.get(sessionId) ?? EMPTY_SESSION_STATE;
                for (const { key, value } of entries) {
                  const arr = next[key];
                  if (arr.includes(value)) continue;
                  next = { ...next, [key]: [...arr, value] };
                }
                const out = new Map(m);
                out.set(sessionId, next);
                return out;
              }),
            ),
          );
        }) as SessionStateApi["appendBatch"],
      });
    }),
  );
