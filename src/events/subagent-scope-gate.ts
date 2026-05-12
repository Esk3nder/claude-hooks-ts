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
 * Per the official Claude Code spec the canonical correlation token is
 * `agent_id`. When present, we use it verbatim. Otherwise we fall back to a
 * stable content hash of the payload (deterministic across start/stop pairs
 * with identical payloads, distinct for parallel starts that differ).
 *
 * For backward-compat we also honour `task_id` (older Claude Code builds and
 * existing tests). Resolution order: agent_id > task_id > payload-hash.
 */
const sha1Short = (input: string): string =>
  createHash("sha1").update(input).digest("hex").slice(0, 16);

const payloadHash = (payload: Record<string, unknown>): string => {
  const keys = Object.keys(payload)
    .filter((k) => k !== "session_id")
    .sort();
  const canonical = keys.map((k) => [k, payload[k]] as const);
  return sha1Short(JSON.stringify(canonical));
};

/**
 * Read agent_type from a payload, preferring the canonical `agent_type` field
 * but falling back to the legacy `subagent_type` for older payloads.
 */
const readAgentType = (payload: Record<string, unknown>): string => {
  if (typeof payload["agent_type"] === "string") {
    return payload["agent_type"];
  }
  if (typeof payload["subagent_type"] === "string") {
    return payload["subagent_type"];
  }
  return "unknown";
};

export const invocationKey = (
  payload: { readonly _tag: string; readonly session_id: string } & Record<
    string,
    unknown
  >,
): string => {
  const agentType = readAgentType(payload);
  const agentId =
    typeof payload["agent_id"] === "string" ? payload["agent_id"] : null;
  const taskId =
    typeof payload["task_id"] === "string" ? payload["task_id"] : null;
  // Canonical identity: agent_id > task_id > payload-hash.
  const ident = agentId ?? taskId ?? `h${payloadHash(payload)}`;
  return `${payload.session_id}:${agentType}:${ident}`;
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

    if (!prev.subagent_starts.includes(key)) {
      yield* state
        .append(payload.session_id, "subagent_starts", key)
        .pipe(Effect.catchAll(() => Effect.succeed(undefined as void)));
    }

    const agentType = readAgentType(
      payload as unknown as Record<string, unknown>,
    );
    const role = lookupRole(agentType);
    const subagentLabel = agentType === "unknown" ? "subagent" : agentType;
    const additionalContext = `Subagent ${subagentLabel} (${role.mode}): ${role.scopeRule} ${role.outputContract}`;
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

    if (!prev.subagent_stops.includes(key)) {
      yield* state
        .append(payload.session_id, "subagent_stops", key)
        .pipe(Effect.catchAll(() => Effect.succeed(undefined as void)));
    }

    const agentType = readAgentType(
      payload as unknown as Record<string, unknown>,
    );
    const role = lookupRole(agentType);
    if (!role.investigative) return SAFE_DEFAULT;
    // Canonical field is `output`; older payloads may carry `result`.
    const evidenceText = payload.output ?? payload.result;
    if (hasEvidence(evidenceText)) return SAFE_DEFAULT;

    if (!prev.subagent_stops.includes(`${key}:blocked`)) {
      yield* state
        .append(payload.session_id, "subagent_stops", `${key}:blocked`)
        .pipe(Effect.catchAll(() => Effect.succeed(undefined as void)));
    }

    const decision: HookDecision = {
      decision: "block",
      reason: `Subagent output lacks evidence. ${role.outputContract}`,
    };
    return decision;
  });
