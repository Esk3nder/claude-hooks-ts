import { Effect } from "effect";
import type { NormalizedHookEvent } from "../schema/normalized.ts";
import type { HookDecision } from "../schema/decisions.ts";
import { NO_DECISION } from "../schema/decisions.ts";
import {
  SessionState,
  EMPTY_SESSION_STATE,
} from "../services/session-state.ts";
import { lookupRole, hasEvidence } from "../policies/subagent-roles.ts";
import { stableHookPayloadHash } from "../schema/normalized.ts";
import { reportHookFailure } from "../services/hook-failure.ts";
import { loadRuntimeConfig } from "../services/runtime-config.ts";
import {
  WorkerRuns,
  hashWorkerPrompt,
  type WorkerRunCompletionMetadata,
} from "../services/worker-runs.ts";
import { parseWorkerResultText } from "../services/worker-supervisor.ts";

export const invocationKey = (payload: {
  readonly session_id: string;
  readonly agent_type: string;
  readonly agent_id: string;
}): string => `${payload.session_id}:${payload.agent_type}:${payload.agent_id}`;

export const inferWorkerScope = (prompt: string | undefined): string => {
  if (prompt === undefined) return "**/*";
  const match = /(?:^|\n)\s*(?:scope|files?|paths?)\s*:\s*([^\n]+)/i.exec(prompt);
  const scope = match?.[1]?.trim();
  return scope === undefined || scope.length === 0 ? "**/*" : scope;
};

const roleModeForRun = (agentType: string): "read-only" | "write-allowed" =>
  lookupRole(agentType).mode === "write-allowed" ? "write-allowed" : "read-only";

const recordWorkerStart = (
  payload: Extract<NormalizedHookEvent, { readonly _tag: "SubagentStart" }>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const runs = yield* Effect.serviceOption(WorkerRuns);
    if (runs._tag === "None") return;
    const promptHash =
      payload.prompt === undefined
        ? stableHookPayloadHash(payload as unknown as Record<string, unknown>)
        : hashWorkerPrompt(payload.prompt);
    const existing = yield* runs.value
      .get(payload.agent_id)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (existing === null) {
      yield* runs.value.createQueued({
        worker_id: payload.agent_id,
        session_id: payload.session_id,
        agent_id: payload.agent_id,
        agent_type: payload.agent_type,
        mode: roleModeForRun(payload.agent_type),
        prompt_hash: promptHash,
        scope: inferWorkerScope(payload.prompt),
      });
      yield* runs.value.markRunning(payload.agent_id);
      return;
    }
    if (existing.status !== "running") {
      yield* runs.value.markRunning(payload.agent_id);
    }
  }).pipe(
    Effect.catchAll((cause) =>
      reportHookFailure({
        kind: "worker_enqueue_failed",
        event: "SubagentStart",
        sessionId: payload.session_id,
        cause,
        hookSafe: true,
        context: {
          op: "worker-runs.start",
          agent_id: payload.agent_id,
          agent_type: payload.agent_type,
        },
      }),
    ),
  );

const recordWorkerStop = (
  payload: Extract<NormalizedHookEvent, { readonly _tag: "SubagentStop" }>,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const runs = yield* Effect.serviceOption(WorkerRuns);
    if (runs._tag === "None") return null;
    if (payload.output === undefined || payload.output.trim().length === 0) {
      const reason = "worker output was missing; strict WorkerResult JSON is required";
      yield* runs.value.markBlocked(payload.agent_id, reason).pipe(Effect.catchAll(() => Effect.void));
      return reason;
    }
    const config = yield* loadRuntimeConfig;
    const parsed = yield* parseWorkerResultText(payload.agent_id, payload.output).pipe(
      Effect.either,
    );
    if (parsed._tag === "Left") {
      const reason = "worker output did not decode as WorkerResult";
      yield* runs.value.markBlocked(payload.agent_id, reason).pipe(Effect.catchAll(() => Effect.void));
      if (config.workerRequireStructuredResult) {
        return reason;
      }
      return null;
    }
    const run = yield* runs.value
      .get(payload.agent_id)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    const mode = run?.mode ?? roleModeForRun(payload.agent_type);
    if (mode === "read-only" && parsed.right.changes_made.length > 0) {
      const reason = "read-only worker reported changes_made; inspect-only workers must not change files";
      yield* runs.value.markBlocked(
        payload.agent_id,
        reason,
      );
      return reason;
    }
    let completionMetadata: WorkerRunCompletionMetadata = {};
    if (mode === "write-allowed" && parsed.right.changes_made.length > 0) {
      if (parsed.right.blockers.length > 0) {
        const reason = `write worker reported blockers: ${parsed.right.blockers.slice(0, 3).join("; ")}`;
        yield* runs.value.markBlocked(payload.agent_id, reason);
        return reason;
      }
      const failedVerification = parsed.right.verification.find((check) => check.status !== "passed");
      if (parsed.right.verification.length === 0 || failedVerification !== undefined) {
        const reason =
          failedVerification === undefined
            ? "write worker changed files without verification evidence"
            : `write worker verification not passed: ${failedVerification.check}=${failedVerification.status}`;
        yield* runs.value.markBlocked(payload.agent_id, reason);
        return reason;
      }
      if (run?.patch_path === undefined) {
        const reason = "write worker reported changes without a captured isolated patch";
        yield* runs.value.markBlocked(payload.agent_id, reason);
        return reason;
      }
      completionMetadata = {
        ...(run.isolation === undefined ? {} : { isolation: run.isolation }),
        ...(run.workspace_path === undefined ? {} : { workspace_path: run.workspace_path }),
        patch_path: run.patch_path,
      };
    }
    yield* runs.value.complete(payload.agent_id, parsed.right, undefined, completionMetadata);
    return null;
  }).pipe(
    Effect.catchAll((cause) =>
      reportHookFailure({
        kind: "worker_enqueue_failed",
        event: "SubagentStop",
        sessionId: payload.session_id,
        cause,
        hookSafe: true,
        context: {
          op: "worker-runs.stop",
          agent_id: payload.agent_id,
          agent_type: payload.agent_type,
        },
      }).pipe(Effect.as(null)),
    ),
  );

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
    yield* recordWorkerStart(payload);

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
    const workerBlockReason = yield* recordWorkerStop(payload);
    if (workerBlockReason !== null) {
      return {
        decision: "block",
        reason: workerBlockReason,
      };
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
