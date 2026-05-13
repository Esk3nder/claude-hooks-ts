import { Effect } from "effect";
import type { NormalizedHookEvent } from "../schema/normalized.ts";
import type { HookDecision } from "../schema/decisions.ts";
import { NO_DECISION } from "../schema/decisions.ts";
import {
  SessionState,
  EMPTY_SESSION_STATE,
} from "../services/session-state.ts";
import { lookupRole, hasEvidence } from "../policies/subagent-roles.ts";

export const invocationKey = (payload: {
  readonly session_id: string;
  readonly agent_type: string;
  readonly agent_id: string;
}): string => `${payload.session_id}:${payload.agent_type}:${payload.agent_id}`;

export const handleSubagentStart = (
  payload: NormalizedHookEvent,
): Effect.Effect<HookDecision, never, SessionState> =>
  Effect.gen(function* () {
    if (payload._tag !== "SubagentStart") return NO_DECISION;
    const state = yield* SessionState;
    const prev = yield* state
      .get(payload.session_id)
      .pipe(Effect.catchAll(() => Effect.succeed(EMPTY_SESSION_STATE)));
    const key = invocationKey(payload);

    if (!prev.subagent_starts.includes(key)) {
      yield* state
        .append(payload.session_id, "subagent_starts", key)
        .pipe(Effect.catchAll(() => Effect.succeed(undefined as void)));
    }

    const agentType = payload.agent_type;
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
  payload: NormalizedHookEvent,
): Effect.Effect<HookDecision, never, SessionState> =>
  Effect.gen(function* () {
    if (payload._tag !== "SubagentStop") return NO_DECISION;
    const state = yield* SessionState;
    const prev = yield* state
      .get(payload.session_id)
      .pipe(Effect.catchAll(() => Effect.succeed(EMPTY_SESSION_STATE)));
    const key = invocationKey(payload);

    if (!prev.subagent_stops.includes(key)) {
      yield* state
        .append(payload.session_id, "subagent_stops", key)
        .pipe(Effect.catchAll(() => Effect.succeed(undefined as void)));
    }

    const agentType = payload.agent_type;
    const role = lookupRole(agentType);
    if (!role.investigative) return NO_DECISION;
    const evidenceText = payload.output;
    const evidenceOptions = role.judgmentOnly ? { judgmentOnly: true } : {};
    if (hasEvidence(evidenceText, evidenceOptions)) return NO_DECISION;

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
