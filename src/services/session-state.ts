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
  readonly last_mode: string | null;
  readonly last_tier: number | null;
  readonly engagement_required: boolean;
  readonly expected_isa_path: string | null;
  /** Stable project root frozen at engagement creation; see schema. */
  readonly session_root: string | null;
  /** Frozen absolute form of `expected_isa_path`; see schema. */
  readonly expected_isa_path_absolute: string | null;
  readonly isa_engaged_at: string | null;
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
  last_mode: null,
  last_tier: null,
  engagement_required: false,
  expected_isa_path: null,
  session_root: null,
  expected_isa_path_absolute: null,
  isa_engaged_at: null,
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
  /**
   * Reset the session record to {@link EMPTY_SESSION_STATE}, overwriting any
   * existing on-disk state. Used by `CwdChanged` when a project switch is
   * detected so stale `files_changed` / `verification_status` from the
   * previous project don't bleed across.
   */
  readonly reset: (sessionId: string) => Effect.Effect<void, FsError>;
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

const KNOWN_RECORD_KEYS: ReadonlySet<string> = new Set(
  Object.keys(EMPTY_SESSION_STATE),
);

const hasAnyKnownKey = (parsed: Record<string, unknown>): boolean => {
  for (const k of Object.keys(parsed)) {
    if (KNOWN_RECORD_KEYS.has(k)) return true;
  }
  return false;
};

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
  // Forward-compat default merge: if the JSON looks like a legacy session
  // record (has at least one known schema key) but is missing newly-added
  // fields, fill them with EMPTY_SESSION_STATE defaults before strict
  // decode. Without this, introducing a new schema field would trigger
  // the backup-and-reset path on every in-flight session and silently
  // wipe their engagement bookkeeping. Records that look like garbage
  // (no recognized keys) still hit the strict path → backup → reset.
  const candidate =
    isRecord(parsed) && hasAnyKnownKey(parsed)
      ? { ...EMPTY_SESSION_STATE, ...parsed }
      : parsed;
  const decoded = decodeStrict(candidate);
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
      last_mode:
        typeof get("last_mode") === "string"
          ? (get("last_mode") as string)
          : null,
      last_tier:
        typeof get("last_tier") === "number"
          ? (get("last_tier") as number)
          : null,
      engagement_required: get("engagement_required") === true,
      expected_isa_path:
        typeof get("expected_isa_path") === "string"
          ? (get("expected_isa_path") as string)
          : null,
      session_root:
        typeof get("session_root") === "string"
          ? (get("session_root") as string)
          : null,
      expected_isa_path_absolute:
        typeof get("expected_isa_path_absolute") === "string"
          ? (get("expected_isa_path_absolute") as string)
          : null,
      isa_engaged_at:
        typeof get("isa_engaged_at") === "string"
          ? (get("isa_engaged_at") as string)
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
      reset: (sessionId: string) =>
        Effect.tryPromise({
          try: async () => {
            const file = statePath(root, sessionId);
            await fs.mkdir(path.dirname(file), { recursive: true });
            await withFileLock(file, async () => {
              await fs.writeFile(
                file,
                JSON.stringify(EMPTY_SESSION_STATE, null, 2),
                "utf8",
              );
            });
          },
          catch: (cause) =>
            new FsError({
              op: "session-state.reset",
              path: statePath(root, sessionId),
              message: String(cause),
              cause,
            }),
        }),
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
        reset: (sessionId: string) =>
          Ref.update(ref, (m) => {
            const out = new Map(m);
            out.set(sessionId, EMPTY_SESSION_STATE);
            return out;
          }),
      });
    }),
  );
