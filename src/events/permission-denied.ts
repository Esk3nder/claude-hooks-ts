import { Effect } from "effect";
import * as path from "node:path";
import type { HookPayload } from "../schema/payloads.ts";
import type { HookDecision } from "../schema/decisions.ts";
import { SAFE_DEFAULT } from "../schema/decisions.ts";
import { eventStream, PermissionDeniedRecordSchema } from "../schema/events.ts";
import { collectStream, EventStore } from "../services/event-store.ts";
import { Project } from "../services/project.ts";
import { derivePatternKey } from "../policies/permission-patterns.ts";

interface PermissionDeniedLedgerEntry {
  readonly session_id: string;
  readonly tool_name: string;
  readonly tool_input: unknown;
  readonly pattern_key: string;
  readonly denial_reason: string;
  readonly permission_mode: string | null;
  readonly ts: string;
}

const REPEAT_WINDOW_MS = 30 * 60 * 1000;
const REPEAT_THRESHOLD = 3;
const TAIL_LINES = 100;

const permissionDeniedStream = (root: string) =>
  eventStream(
    "permission-denials",
    path.join(root, ".claude-hooks", "state", "permission-denials.jsonl"),
    PermissionDeniedRecordSchema,
    { maxRecords: TAIL_LINES },
  );

/**
 * PermissionDenied — appends to <cwd>/.claude-hooks/state/permission-denials.jsonl,
 * then scans the recent tail for repeated denials matching the same
 * (tool_name, derivePatternKey) within the last 30 minutes. If the count
 * reaches REPEAT_THRESHOLD, emits a ContextInjection nudging the user to
 * configure their settings.json allowlist.
 */
export const handlePermissionDenied = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, EventStore | Project> =>
  Effect.gen(function* () {
    if (payload._tag !== "PermissionDenied") return SAFE_DEFAULT;
    const project = yield* Project;
    const eventStore = yield* EventStore;
    const root = yield* project.root();
    const patternKey = derivePatternKey(payload.tool_name, payload.tool_input);
    const nowMs = Date.now();
    const entry: PermissionDeniedLedgerEntry = {
      session_id: payload.session_id,
      tool_name: payload.tool_name,
      tool_input: payload.tool_input,
      pattern_key: patternKey,
      denial_reason: payload.denial_reason,
      permission_mode: payload.permission_mode ?? null,
      ts: new Date(nowMs).toISOString(),
    };

    const stream = permissionDeniedStream(root);
    const recentRecords = yield* eventStore
      .append(stream, entry)
      .pipe(
        Effect.zipRight(collectStream(eventStore.tail(stream, TAIL_LINES))),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            process.stderr.write(
              `permission-denied: event-store append/tail failed: ${String(err).slice(0, 160)}\n`,
            );
            return [] as ReadonlyArray<PermissionDeniedLedgerEntry>;
          }),
        ),
      );

    let count = 0;
    for (const obj of recentRecords) {
      if (
        obj.tool_name === payload.tool_name &&
        obj.pattern_key === patternKey &&
        typeof obj.ts === "string"
      ) {
        const ts = Date.parse(obj.ts);
        if (!Number.isNaN(ts) && nowMs - ts <= REPEAT_WINDOW_MS) {
          count += 1;
        }
      }
    }

    if (count >= REPEAT_THRESHOLD) {
      return {
        hookSpecificOutput: {
          hookEventName: "PermissionDenied",
          additionalContext: `Pattern ${patternKey} denied ${count} times in last 30m. Consider adding to settings.json permissions allowlist if intentional.`,
        },
      };
    }
    return SAFE_DEFAULT;
  });
