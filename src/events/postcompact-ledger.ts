import { Effect } from "effect";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import * as path from "node:path";
import type { HookPayload } from "../schema/payloads.ts";
import type { HookDecision } from "../schema/decisions.ts";
import { NO_DECISION } from "../schema/decisions.ts";
import { eventStream, PostCompactRecordSchema } from "../schema/events.ts";
import { EventStore, summarizeEventStoreError } from "../services/event-store.ts";
import { Project } from "../services/project.ts";
import { logWarning } from "../services/diagnostics.ts";

const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9._-]/g, "_");

/**
 * Locate the most recent pre-compact snapshot for a session_id by mtime.
 * The PreCompact handler includes trigger/instruction tags in the filename
 * after the sanitized session prefix; match by prefix and pick the newest.
 * Returns null when no snapshot exists for this session.
 */
const findLatestSnapshot = (
  root: string,
  sessionId: string,
): string | null => {
  const dir = path.join(root, ".claude-hooks", "state", "compact-snapshots");
  if (!existsSync(dir)) return null;
  const prefix = `${sanitize(sessionId)}-`;
  let latest: string | null = null;
  let latestMtime = 0;
  let entries: ReadonlyArray<string>;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(".md")) continue;
    const full = path.join(dir, name);
    try {
      const s = statSync(full);
      if (s.mtimeMs > latestMtime) {
        latestMtime = s.mtimeMs;
        latest = full;
      }
    } catch {
      // best-effort
    }
  }
  return latest;
};

/**
 * Extract the `## Active ISAs` section body from a snapshot markdown. The
 * PreCompact handler writes this section verbatim; we slice from the
 * heading to the next H2 (`## `) or EOF. Returns "" if the section isn't
 * present (older snapshots predating slice 3b).
 */
const extractActiveIsasSection = (snapshotMd: string): string => {
  const m = snapshotMd.match(/^##\s+Active ISAs\s*$/im);
  if (!m || m.index === undefined) return "";
  const after = snapshotMd.slice(m.index + m[0].length);
  const end = after.match(/\n##\s+(?!#)/);
  const body = end ? after.slice(0, end.index) : after;
  return body.trim();
};

const MAX_REHYDRATE_INJECT = 1024;
const MAX_SNAPSHOT_READ_BYTES = 128 * 1024;
const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, Math.max(0, max - 3)) + "...";

const readSnapshotPrefix = (file: string): string | null => {
  let fd: number | null = null;
  try {
    const size = Math.max(0, Math.min(statSync(file).size, MAX_SNAPSHOT_READ_BYTES));
    const buffer = Buffer.alloc(size);
    fd = openSync(file, "r");
    const bytesRead = readSync(fd, buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }
};

interface PostCompactLedgerEntry {
  readonly session_id: string;
  readonly trigger: string;
  readonly compacted_at: string;
  readonly snapshot_path: string | null;
}

/**
 * PostCompact handler — appends an audit entry to a JSONL ledger so we can
 * reconstruct what happened around each compaction event. Best-effort:
 * always returns NO_DECISION and never propagates write failures.
 *
 * Cross-process safety: EventStore owns locking, line caps, and append
 * serialization so sibling dispatcher processes don't interleave partial
 * JSON lines.
 */
export const handlePostCompact = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, EventStore | Project> =>
  Effect.gen(function* () {
    if (payload._tag !== "PostCompact") return NO_DECISION;
    const eventStore = yield* EventStore;
    const project = yield* Project;

    const root = yield* project.root();
    const ts = Date.now();
    const tsIso = new Date(ts).toISOString();
    const latestSnap = findLatestSnapshot(root, payload.session_id);

    const entry: PostCompactLedgerEntry = {
      session_id: payload.session_id,
      trigger: payload.trigger ?? "unknown",
      compacted_at: tsIso,
      snapshot_path: latestSnap,
    };

    const ledgerPath = path.join(
      root,
      ".claude-hooks",
      "state",
      "postcompact-ledger.jsonl",
    );

    yield* eventStore.append(eventStream("postcompact", ledgerPath, PostCompactRecordSchema, { maxRecords: 1_000 }), entry).pipe(
      Effect.catchAll((cause: unknown) => {
        const msg = summarizeEventStoreError(cause);
        return logWarning(`postcompact-ledger: write failed: ${msg}`);
      }),
    );

    // 3b: rehydrate ISA context from the most recent precompact snapshot.
    // Compaction collapses the conversation buffer; without rehydration the
    // post-compact model would lose track of which ISA(s) it was working
    // against. We emit just the `## Active ISAs` section as additionalContext
    // so the model can re-read those files itself if needed.
    if (latestSnap === null) return NO_DECISION;
    const snapshotMd = readSnapshotPrefix(latestSnap);
    if (snapshotMd === null) return NO_DECISION;
    const isaSection = extractActiveIsasSection(snapshotMd);
    if (isaSection.length === 0) return NO_DECISION;
    const additionalContext = truncate(
      `Rehydrated ISA context (post-compact, from ${latestSnap}):\n${isaSection}`,
      MAX_REHYDRATE_INJECT,
    );
    const out: HookDecision = {
      hookSpecificOutput: {
        hookEventName: "PostCompact",
        additionalContext,
      },
    };
    return out;
  });
