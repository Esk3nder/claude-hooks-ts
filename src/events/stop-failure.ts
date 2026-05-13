import { Effect } from "effect";
import * as path from "node:path";
import type { HookPayload } from "../schema/payloads.ts";
import type { HookDecision } from "../schema/decisions.ts";
import { SAFE_DEFAULT } from "../schema/decisions.ts";
import { eventStream, StopFailureRecordSchema } from "../schema/events.ts";
import { EventStore, summarizeEventStoreError } from "../services/event-store.ts";
import { Project } from "../services/project.ts";

interface StopFailureLedgerEntry {
  readonly session_id: string;
  readonly error_type: string;
  readonly error_category: FailureCategory;
  readonly error_message: string;
  readonly ts: string;
}

export type FailureCategory =
  | "rate_limit"
  | "authentication"
  | "server_error"
  | "max_tokens"
  | "other";

export const categorizeFailure = (
  errorType: string,
  errorMessage: string,
): FailureCategory => {
  const t = errorType.toLowerCase();
  const m = errorMessage.toLowerCase();
  if (t.includes("rate") || t.includes("429") || m.includes("rate limit")) {
    return "rate_limit";
  }
  if (
    t.includes("auth") ||
    t.includes("401") ||
    t.includes("403") ||
    m.includes("unauthorized") ||
    m.includes("authentication")
  ) {
    return "authentication";
  }
  if (
    t.includes("max_tokens") ||
    t.includes("max-tokens") ||
    t.includes("context_length") ||
    m.includes("max tokens") ||
    m.includes("context length")
  ) {
    return "max_tokens";
  }
  if (
    t.includes("server") ||
    /5\d{2}/.test(t) ||
    t.includes("internal") ||
    t.includes("overload")
  ) {
    return "server_error";
  }
  return "other";
};

const persistedErrorMessage = (
  category: FailureCategory,
  errorMessage: string,
): string =>
  category === "authentication"
    ? `authentication failure message redacted (${Buffer.byteLength(errorMessage, "utf8")} bytes)`
    : errorMessage;

/**
 * StopFailure — appends to <cwd>/.claude-hooks/state/failures.jsonl, then
 * categorizes the error and may emit a ContextInjection for actionable
 * categories (rate_limit, authentication). Other categories return
 * SAFE_DEFAULT to avoid polluting context with transient noise.
 */
export const handleStopFailure = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, EventStore | Project> =>
  Effect.gen(function* () {
    if (payload._tag !== "StopFailure") return SAFE_DEFAULT;
    const eventStore = yield* EventStore;
    const project = yield* Project;
    const root = yield* project.root();
    const ledgerPath = path.join(
      root,
      ".claude-hooks",
      "state",
      "failures.jsonl",
    );
    const category = categorizeFailure(
      payload.error_type,
      payload.error_message,
    );
    const entry: StopFailureLedgerEntry = {
      session_id: payload.session_id,
      error_type: payload.error_type,
      error_category: category,
      error_message: persistedErrorMessage(category, payload.error_message),
      ts: new Date().toISOString(),
    };
    yield* eventStore
      .append(eventStream("stop-failures", ledgerPath, StopFailureRecordSchema, { maxRecords: 1_000 }), entry)
      .pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            process.stderr.write(
              `stop-failure: ledger write failed: ${summarizeEventStoreError(err)}\n`,
            );
          }),
        ),
      );

    if (category === "rate_limit") {
      return {
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext:
            "Recent failure: rate_limit. Consider waiting 60s or batching tool calls.",
        },
      };
    }
    if (category === "authentication") {
      return {
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext: "Recent failure: authentication. Re-authenticate or refresh provider credentials.",
        },
      };
    }
    return SAFE_DEFAULT;
  });
