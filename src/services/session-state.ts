import { Context, Effect, Layer, Ref, Schema } from "effect";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { FsError } from "../schema/errors.ts";
import { SessionStateRecordSchema } from "../schema/session-state.ts";
import { getCurrentSession } from "./session-context.ts";
import { FileLock, FileLockPlatformLive } from "./file-lock.ts";
import { logWarningSync } from "./diagnostics.ts";
import { sessionStatePath } from "./state-paths.ts";

export type VerificationStatus = "passed" | "failed" | "none";

/**
 * Engagement state — fields the ALGORITHM-engagement choreography reads
 * and writes (UserPromptSubmit → PreToolUse gate → Stop absence gate).
 * Owned conceptually by the prompt-router + engagement-gate; persisted
 * inline in the unified SessionStateRecord (no on-disk migration).
 *
 * `stop_blocked_once` belongs here because its sole consumer is the
 * Stop ISA-absence gate — the boolean is the one-shot release for the
 * engagement absence rule, not a generic verification field.
 */
export interface EngagementState {
  readonly engagement_required: boolean;
  readonly expected_isa_path: string | null;
  /** Stable project root frozen at engagement creation. */
  readonly session_root: string | null;
  /** Frozen absolute form of `expected_isa_path`. */
  readonly expected_isa_path_absolute: string | null;
  readonly isa_engaged_at: string | null;
  readonly last_tier: number | null;
  readonly stop_blocked_once: boolean;
  /**
   * Rule names from regenerate.yaml that were skipped on the previous
   * Stop because there was no time left in the Stop budget. Surfaced
   * by the next UserPromptSubmit so silent skips are observable. (D3)
   */
  readonly regenerate_skipped: ReadonlyArray<string>;
}

/**
 * Verification ledger — append-only evidence collected during a session.
 * Owned by the PostToolUse / session-ledger handlers; read by the Stop
 * "files changed but no verification" gate and the subagent-scope gate.
 */
export interface VerificationLedger {
  readonly files_read: ReadonlyArray<string>;
  readonly files_changed: ReadonlyArray<string>;
  /**
   * Hook-owned evidence/config artifacts that were edited successfully but
   * are intentionally excluded from `files_changed` so they do not trigger
   * the generic Stop verification loop.
   */
  readonly meta_artifacts_changed: ReadonlyArray<string>;
  readonly commands_run: ReadonlyArray<string>;
  readonly commands_failed: ReadonlyArray<string>;
  readonly tests_run: ReadonlyArray<string>;
  readonly verification_status: VerificationStatus;
  readonly verification_at: string | null;
  readonly next_required_action: string | null;
  /**
   * EP P2 #8 — the command string that flipped `verification_status`
   * to `"passed"`. Recorded for audit so a reviewer can see WHICH run
   * of bun test / tsc / pytest etc. counted as verification. Optional
   * for back-compat with legacy records.
   */
  readonly verification_command?: string | null;
  /**
   * EP P2 #8 — subset of `files_changed` heuristically covered by the
   * verification command. Match heuristic: a path is "covered" when
   * its basename appears anywhere in the command string. False
   * positives are cheap (over-recording is benign); false negatives
   * are minor. NOT consulted by any gate yet — record-only at P2.
   */
  readonly verification_files?: ReadonlyArray<string>;
  readonly subagent_starts: ReadonlyArray<string>;
  readonly subagent_stops: ReadonlyArray<string>;
  /**
   * US-14: ISC ids whose `[x]` was flipped by a probe pass during this
   * session (not by a direct model Edit). Consulted by the Stop
   * completeness gate's probe-provenance check.
   */
  readonly probe_verified_iscs: ReadonlyArray<string>;
}

/**
 * Mode/workflow cache — classifier outputs the Stop gates and the
 * engagement directive consult on subsequent turns. Includes the
 * research source-URL ledger because its only Stop-gate consumer
 * (research-mode source-ledger) keys off `last_workflow`.
 */
export interface ModeCache {
  readonly last_workflow: string | null;
  readonly last_mode: string | null;
  readonly source_urls: ReadonlyArray<string>;
  /**
   * True when the prompt-router classified the upstream user message as
   * explicitly requiring web-research sources. Drives the Stop research-
   * mode gate. Kept separate from `last_workflow` so loose alternatives
   * in the priming workflow regex cannot force a Stop block. See
   * `requiresWebSources` in policies/workflow-classifier.ts.
   */
  readonly requires_web_sources: boolean;
  /**
   * Opt-out for the source-ledger Stop gate. Set to true by the
   * PostToolUse ISA-edit handler when the ISA's frontmatter declares
   * `source_ledger: not_applicable`. The Stop gate consults this flag
   * to suppress its source-ledger block even when
   * `requires_web_sources` is true. Default false — the user/agent
   * must explicitly opt out per ISA.
   */
  readonly source_ledger_opt_out: boolean;
}

/**
 * Unified on-disk record. Composed from the three focused sub-records
 * above; persisted as a single JSON file per session so this split has
 * no migration cost. Each handler reads/writes through the SessionState
 * service but conceptually touches only one slice.
 */
export interface SessionStateRecord
  extends EngagementState,
    VerificationLedger,
    ModeCache {
  /**
   * P0-5: schema version stamp. Records written by this build carry the
   * current `SESSION_STATE_SCHEMA_VERSION`. Optional on read (legacy
   * records without it parse via the forward-compat merge that defaults
   * missing fields). A record with a version GREATER than this build's
   * `SESSION_STATE_SCHEMA_VERSION` is rejected as "from a newer install"
   * — the read returns EMPTY_SESSION_STATE without touching the file
   * (so an older install cannot destroy a newer install's session data).
   */
  readonly _schema_version?: number;
}

/**
 * P0-5: on-disk schema version for session-state records.
 *
 * Increment when: (a) you rename a field, (b) you change the SEMANTICS of
 * an existing field, (c) you delete a field. Do NOT increment when adding
 * a new field — those are forward-compatible via the existing
 * `{ ...EMPTY_SESSION_STATE, ...parsed }` merge in `parseRecordStrict`.
 *
 * When you do increment, also register a migration in
 * `migrateSessionStateRecord` below so legacy records from older versions
 * still parse.
 */
export const SESSION_STATE_SCHEMA_VERSION = 1 as const;

export const EMPTY_SESSION_STATE: SessionStateRecord = {
  _schema_version: SESSION_STATE_SCHEMA_VERSION,
  files_read: [],
  files_changed: [],
  meta_artifacts_changed: [],
  commands_run: [],
  commands_failed: [],
  tests_run: [],
  verification_status: "none",
  verification_at: null,
  next_required_action: null,
  verification_command: null,
  verification_files: [],
  stop_blocked_once: false,
  source_urls: [],
  subagent_starts: [],
  subagent_stops: [],
  probe_verified_iscs: [],
  last_workflow: null,
  last_mode: null,
  last_tier: null,
  requires_web_sources: false,
  source_ledger_opt_out: false,
  engagement_required: false,
  expected_isa_path: null,
  session_root: null,
  expected_isa_path_absolute: null,
  isa_engaged_at: null,
  regenerate_skipped: [],
};

export type AppendableKey =
  | "files_read"
  | "files_changed"
  | "meta_artifacts_changed"
  | "commands_run"
  | "commands_failed"
  | "tests_run"
  | "source_urls"
  | "subagent_starts"
  | "subagent_stops"
  | "probe_verified_iscs";

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

const statePath = (
  root: string,
  sessionId: string,
  sessionRoot?: string | null,
): string => sessionStatePath({ root, sessionId, sessionRoot });

const MAX_SESSION_ARRAY_ITEMS = 1_000;

const appendableKeys = [
  "files_read",
  "files_changed",
  "meta_artifacts_changed",
  "commands_run",
  "commands_failed",
  "tests_run",
  "source_urls",
  "subagent_starts",
  "subagent_stops",
  "probe_verified_iscs",
] as const satisfies ReadonlyArray<AppendableKey>;

const capArray = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  values.slice(-MAX_SESSION_ARRAY_ITEMS);

const capSessionArrays = (record: SessionStateRecord): SessionStateRecord => {
  let next = record;
  for (const key of appendableKeys) {
    const capped = capArray(next[key]);
    if (capped.length !== next[key].length) next = { ...next, [key]: capped };
  }
  return next;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

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

const isNodeErrorCode = (cause: unknown, code: string): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { code?: unknown }).code === code;

const fsError = (op: string, path: string, cause: unknown): FsError =>
  cause instanceof FsError
    ? cause
    : new FsError({ op, path, message: String(cause), cause });

const backupCorruptRecord = (
  raw: string,
  filePath: string,
  sessionId: string,
  reason: string,
): void => {
  try {
    const bak = `${filePath}.corrupt-${Date.now()}.bak`;
    fsSync.mkdirSync(path.dirname(bak), { recursive: true });
    fsSync.writeFileSync(bak, raw, "utf8");
  } catch {
    // best-effort
  }
  logWarningSync(`session-state: ${reason} for ${sessionId}; refusing to reset implicitly`);
};

/**
 * P0-5: detect a record from a newer build (higher `_schema_version`).
 * Older builds must NOT silently merge a future record's fields with
 * stale assumptions, and must NOT back-up-and-reset (that would let an
 * older install destroy a newer install's session data). Instead we
 * warn loudly and return EMPTY so the older build proceeds with a
 * clean slate while leaving the on-disk record untouched.
 */
const detectFutureSchemaVersion = (
  parsed: unknown,
  filePath: string,
  sessionId: string,
): number | null => {
  if (!isRecord(parsed)) return null;
  const v = parsed["_schema_version"];
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v <= SESSION_STATE_SCHEMA_VERSION) return null;
  logWarningSync(
    `session-state: _schema_version ${v} from ${filePath} is newer than this build's ${SESSION_STATE_SCHEMA_VERSION} for session ${sessionId}; refusing to merge — returning EMPTY_SESSION_STATE and leaving the on-disk record untouched.`,
  );
  return v;
};

const parseRecordStrict = (
  raw: string,
  filePath: string,
  sessionId: string,
  op: string,
): SessionStateRecord | FsError => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    backupCorruptRecord(raw, filePath, sessionId, "invalid JSON");
    return fsError(op, filePath, cause);
  }
  // P0-5: future-version short-circuit BEFORE merge/decode. If the record
  // was written by a newer build, do not pretend to understand it.
  if (detectFutureSchemaVersion(parsed, filePath, sessionId) !== null) {
    return EMPTY_SESSION_STATE;
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
    return capSessionArrays(decoded.right as SessionStateRecord);
  }
  backupCorruptRecord(raw, filePath, sessionId, "schema mismatch");
  return fsError(op, filePath, decoded.left);
};

const readRecordOrEmpty = async (
  file: string,
  sessionId: string,
  op: string,
): Promise<SessionStateRecord> => {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (cause) {
    if (isNodeErrorCode(cause, "ENOENT")) return EMPTY_SESSION_STATE;
    throw fsError(op, file, cause);
  }
  const decoded = parseRecordStrict(raw, file, sessionId, op);
  if (decoded instanceof FsError) throw decoded;
  return decoded;
};

const readRecordIfExists = async (
  file: string,
  sessionId: string,
  op: string,
): Promise<SessionStateRecord> => {
  if (!fsSync.existsSync(file)) {
    return EMPTY_SESSION_STATE;
  }
  return readRecordOrEmpty(file, sessionId, op);
};

const writeRecordAtomic = async (
  file: string,
  record: SessionStateRecord,
  op: string,
): Promise<void> => {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tempFile = path.join(
    dir,
    `${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`,
  );
  let committed = false;
  try {
    await fs.writeFile(tempFile, JSON.stringify(record, null, 2), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(tempFile, file);
    committed = true;
  } catch (cause) {
    if (!committed) {
      try {
        await fs.rm(tempFile, { force: true });
      } catch {
        // best-effort cleanup; the final state file was not touched
      }
    }
    throw fsError(op, file, cause);
  }
};

const readRecordFollowingSessionRoot = async (
  root: string,
  sessionId: string,
  op: string,
): Promise<SessionStateRecord> => {
  const primary = statePath(root, sessionId);
  const record = await readRecordOrEmpty(primary, sessionId, op);
  if (record.session_root === null) return record;

  const canonical = statePath(root, sessionId, record.session_root);
  if (path.resolve(canonical) === path.resolve(primary)) return record;

  const canonicalRecord = await readRecordIfExists(canonical, sessionId, op);
  return canonicalRecord === EMPTY_SESSION_STATE ? record : canonicalRecord;
};

const recordForWritablePath = async (
  root: string,
  sessionId: string,
  patch: Partial<SessionStateRecord>,
  op: string,
): Promise<{
  readonly file: string;
  readonly previous: SessionStateRecord;
}> => {
  const primary = statePath(root, sessionId);
  const primaryRecord = await readRecordIfExists(primary, sessionId, op);
  const sessionRoot = patch.session_root ?? primaryRecord.session_root;
  const file = statePath(root, sessionId, sessionRoot);
  if (path.resolve(file) === path.resolve(primary)) {
    return { file, previous: primaryRecord };
  }

  const canonicalRecord = await readRecordIfExists(file, sessionId, op);
  return {
    file,
    previous: canonicalRecord === EMPTY_SESSION_STATE ? primaryRecord : canonicalRecord,
  };
};


const mergePatch = (
  prev: SessionStateRecord,
  patch: Partial<SessionStateRecord>,
): SessionStateRecord => {
  const merged = {
    ...prev,
    ...patch,
    ...(patch.verification_status === undefined
      ? {}
      : {
          verification_at:
            patch.verification_at ??
            (patch.verification_status === "none" ? null : new Date().toISOString()),
        }),
  };
  return capSessionArrays(merged);
};

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

export const SessionStateLiveBase = (
  root: string = process.cwd(),
): Layer.Layer<SessionState, never, FileLock> =>
  Layer.effect(
    SessionState,
    Effect.map(FileLock, (locks) => SessionState.of({
      get: ((...args: ReadonlyArray<unknown>) => {
        const explicit =
          typeof args[0] === "string" ? (args[0] as string) : undefined;
        return resolveSessionId(explicit).pipe(
          Effect.flatMap((sessionId) =>
            Effect.tryPromise({
              try: async () => {
                return readRecordFollowingSessionRoot(root, sessionId, "session-state.get");
              },
              catch: (cause) => fsError("session-state.get", statePath(root, sessionId), cause),
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
                const { file, previous } = await recordForWritablePath(
                  root,
                  sessionId,
                  patch,
                  "session-state.update",
                );
                await Effect.runPromise(
                  locks.withLock(
                    file,
                    Effect.tryPromise({
                      try: async () => {
                        const latest = await readRecordIfExists(file, sessionId, "session-state.update");
                        const prev = latest === EMPTY_SESSION_STATE ? previous : latest;
                        const next = mergePatch(prev, patch);
                        await writeRecordAtomic(file, next, "session-state.update");
                      },
                      catch: (cause) => fsError("session-state.update", file, cause),
                    }),
                  ).pipe(
                    Effect.mapError((cause) => fsError("session-state.update", file, cause)),
                  ),
                );
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
              appendBatchLive(locks, root, sessionId, entries),
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
              appendBatchLive(locks, root, sessionId, entries),
            ),
          );
      }) as SessionStateApi["appendBatch"],
      reset: (sessionId: string) =>
        Effect.tryPromise({
          try: async () => {
            const { file } = await recordForWritablePath(
              root,
              sessionId,
              {},
              "session-state.reset",
            );
            await Effect.runPromise(
              locks.withLock(
                file,
                Effect.tryPromise({
                  try: () => writeRecordAtomic(file, EMPTY_SESSION_STATE, "session-state.reset"),
                  catch: (cause) => fsError("session-state.reset", file, cause),
                }),
              ).pipe(
                Effect.mapError((cause) => fsError("session-state.reset", file, cause)),
              ),
            );
          },
          catch: (cause) =>
            new FsError({
              op: "session-state.reset",
              path: statePath(root, sessionId),
              message: String(cause),
              cause,
            }),
        }),
    })),
  );

export const SessionStateLive = (
  root: string = process.cwd(),
): Layer.Layer<SessionState> =>
  Layer.provide(SessionStateLiveBase(root), FileLockPlatformLive);

const appendBatchLive = (
  locks: FileLock["Type"],
  root: string,
  sessionId: string,
  entries: ReadonlyArray<{
    readonly key: AppendableKey;
    readonly value: string;
  }>,
): Effect.Effect<void, FsError> =>
  Effect.gen(function* () {
    if (entries.length === 0) return;
    const { file, previous } = yield* Effect.tryPromise({
      try: () =>
        recordForWritablePath(root, sessionId, {}, "session-state.appendBatch"),
      catch: (cause) =>
        fsError("session-state.appendBatch", statePath(root, sessionId), cause),
    });
    yield* locks.withLock(
      file,
      Effect.tryPromise({
        try: async () => {
          const latest = await readRecordIfExists(file, sessionId, "session-state.appendBatch");
          const prev = latest === EMPTY_SESSION_STATE ? previous : latest;
          let next: SessionStateRecord = prev;
          for (const { key, value } of entries) {
            const arr = next[key];
            if (arr.includes(value)) continue;
            next = { ...next, [key]: capArray([...arr, value]) };
          }
          if (next === prev) return;
          await writeRecordAtomic(file, next, "session-state.appendBatch");
        },
        catch: (cause) => fsError("session-state.appendBatch", file, cause),
      }),
    ).pipe(
      Effect.mapError((cause) => fsError("session-state.appendBatch", file, cause)),
    );
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
                const nextArr = arr.includes(value) ? arr : capArray([...arr, value]);
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
                  next = { ...next, [key]: capArray([...arr, value]) };
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

// ─────────────────────────────────────────────────────────────────────
// Focused projections — sub-record views over the unified record.
//
// The three slices are persisted inline in one JSON file (no migration),
// but conceptually each handler should only touch the slice it owns.
// These projections make that intent legible at call sites that want it,
// without forcing the 50+ existing call sites to migrate at once.
//
// Engagement: prompt-router (write), pretool engagement gate (read),
//   Stop ISA-absence gate (read + stop_blocked_once write), TaskCompleted
//   evidence gate (read).
// Verification: post-edit-quality (write), session-ledger (write), Stop
//   files-changed-without-verification gate (read), subagent-scope gate
//   (read), batch-context-governor (read).
// ModeCache: prompt-router (write last_workflow / last_mode), Stop
//   research-mode gate (read last_workflow, source_urls).
// ─────────────────────────────────────────────────────────────────────

/** Project the engagement slice from a unified record. */
export const engagementOf = (r: SessionStateRecord): EngagementState => ({
  engagement_required: r.engagement_required,
  expected_isa_path: r.expected_isa_path,
  session_root: r.session_root,
  expected_isa_path_absolute: r.expected_isa_path_absolute,
  isa_engaged_at: r.isa_engaged_at,
  last_tier: r.last_tier,
  stop_blocked_once: r.stop_blocked_once,
  regenerate_skipped: r.regenerate_skipped,
});

/** Project the verification slice from a unified record. */
export const verificationOf = (r: SessionStateRecord): VerificationLedger => ({
  files_read: r.files_read,
  files_changed: r.files_changed,
  meta_artifacts_changed: r.meta_artifacts_changed,
  commands_run: r.commands_run,
  commands_failed: r.commands_failed,
  tests_run: r.tests_run,
  verification_status: r.verification_status,
  verification_at: r.verification_at,
  next_required_action: r.next_required_action,
  subagent_starts: r.subagent_starts,
  subagent_stops: r.subagent_stops,
  probe_verified_iscs: r.probe_verified_iscs,
});

/** Project the mode-cache slice from a unified record. */
export const modeCacheOf = (r: SessionStateRecord): ModeCache => ({
  last_workflow: r.last_workflow,
  last_mode: r.last_mode,
  source_urls: r.source_urls,
  requires_web_sources: r.requires_web_sources,
  source_ledger_opt_out: r.source_ledger_opt_out,
});
