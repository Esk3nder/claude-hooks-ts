import { Effect } from "effect";
import { createHash } from "node:crypto";
import type { HookPayload } from "../schema/payloads.ts";
import type { HookDecision } from "../schema/decisions.ts";
import { SAFE_DEFAULT } from "../schema/decisions.ts";
import {
  SessionState,
  EMPTY_SESSION_STATE,
} from "../services/session-state.ts";
import { lookupRole, hasEvidence } from "../policies/subagent-roles.ts";

/**
 * Stable invocation key for a subagent run.
 *
 * Claude does not always supply a `task_id` for subagent events. The previous
 * fallback used `${session_id}:idx${state.subagent_starts.length}`, which
 * collides for parallel SubagentStarts (both observe the same length) and
 * shifts on retries. We instead derive a content hash from the payload's
 * stable identifying fields. The result is:
 *
 *   - deterministic across start/stop pairs with identical payloads
 *   - distinct for parallel starts whose payloads differ in any way
 *   - independent of how many other subagents have already run
 *
 * The trade-off: when two SubagentStart payloads are byte-identical (same
 * type, same task_id, same any-other-fields), they collapse to one key and
 * only the first start "wins". That is the desired idempotent behaviour for
 * retries; truly distinct invocations always carry distinguishing context
 * from Claude (task_id, subagent_id, prompt, or timestamp metadata).
 */
const sha1Short = (input: string): string =>
  createHash("sha1").update(input).digest("hex").slice(0, 16);

/**
 * Build a stable hash key from whatever identifying fields the payload
 * exposes. We intentionally include the full JSON of the payload (minus
 * the session_id, which is already a prefix) so any divergence in prompt,
 * description, or other fields produces a distinct key.
 */
const payloadHash = (payload: Record<string, unknown>): string => {
  // Stable key ordering for determinism.
  const keys = Object.keys(payload)
    .filter((k) => k !== "session_id")
    .sort();
  const canonical = keys.map((k) => [k, payload[k]] as const);
  return sha1Short(JSON.stringify(canonical));
};

export const invocationKey = (
  payload: { readonly _tag: string; readonly session_id: string } & Record<
    string,
    unknown
  >,
): string => {
  const subagentType =
    typeof payload["subagent_type"] === "string"
      ? payload["subagent_type"]
      : "unknown";
  const taskId =
    typeof payload["task_id"] === "string" ? payload["task_id"] : null;
  // When a task_id is present we trust it as the stable identity (Claude's
  // own correlation token). Otherwise we hash the payload contents.
  const ident = taskId ?? `h${payloadHash(payload)}`;
  return `${payload.session_id}:${subagentType}:${ident}`;
};

export const handleSubagentStart = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, SessionState> =>
  Effect.gen(function* () {
    if (payload._tag !== "SubagentStart") return SAFE_DEFAULT;
    const state = yield* SessionState;
    const prev = yield* state
      .get(payload.session_id)
      .pipe(Effect.catchAll(() => Effect.succeed(EMPTY_SESSION_STATE)));
    const key = invocationKey(
      payload as unknown as Record<string, unknown> & {
        _tag: string;
        session_id: string;
      },
    );

    // Idempotent: only the first start wins for a given key.
    if (!prev.subagent_starts.includes(key)) {
      yield* state
        .append(payload.session_id, "subagent_starts", key)
        .pipe(Effect.catchAll(() => Effect.succeed(undefined as void)));
    }

    const role = lookupRole(payload.subagent_type);
    const subagentLabel = payload.subagent_type ?? "subagent";
    const additionalContext = `Subagent ${subagentLabel} (${role.mode}): ${role.scopeRule}`;
    const decision: HookDecision = {
      hookSpecificOutput: {
        hookEventName: "SubagentStart",
        additionalContext,
      },
    };
    return decision;
  });

export const handleSubagentStop = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, SessionState> =>
  Effect.gen(function* () {
    if (payload._tag !== "SubagentStop") return SAFE_DEFAULT;
    const state = yield* SessionState;
    const prev = yield* state
      .get(payload.session_id)
      .pipe(Effect.catchAll(() => Effect.succeed(EMPTY_SESSION_STATE)));
    const key = invocationKey(
      payload as unknown as Record<string, unknown> & {
        _tag: string;
        session_id: string;
      },
    );

    const alreadyBlocked = prev.subagent_stops.includes(`${key}:blocked`);

    if (!prev.subagent_stops.includes(key)) {
      yield* state
        .append(payload.session_id, "subagent_stops", key)
        .pipe(Effect.catchAll(() => Effect.succeed(undefined as void)));
    }

    const role = lookupRole(payload.subagent_type);
    if (!role.investigative) return SAFE_DEFAULT;
    if (alreadyBlocked) return SAFE_DEFAULT;
    if (hasEvidence(payload.result)) return SAFE_DEFAULT;

    yield* state
      .append(payload.session_id, "subagent_stops", `${key}:blocked`)
      .pipe(Effect.catchAll(() => Effect.succeed(undefined as void)));

    const decision: HookDecision = {
      decision: "block",
      reason:
        "Subagent output lacks evidence. Continue and return findings with file paths, commands run, and confidence.",
    };
    return decision;
  });
