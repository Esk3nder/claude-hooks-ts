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
  scopedWorkerRunId,
  type WorkerRunCompletionMetadata,
} from "../services/worker-runs.ts";
import { parseWorkerResultText } from "../services/worker-supervisor.ts";
import type { WorkerResult } from "../schema/worker-run.ts";

export const invocationKey = (payload: {
  readonly session_id: string;
  readonly agent_type: string;
  readonly agent_id: string;
}): string => `${payload.session_id}:${payload.agent_type}:${payload.agent_id}`;

export const inferWorkerScope = (prompt: string | undefined): string => {
  if (prompt === undefined) return "";
  const match =
    /(?:^|\n)\s*(?:assigned[- ]scope|worker[- ]scope|scope|files?|paths?)\s*:\s*([^\n]+)/i.exec(
      prompt,
    );
  const scope = match?.[1]?.trim();
  if (scope === undefined || scope.length === 0) return "";
  if (/\b(?:you are|return|do not|delegated prompt|worker contract)\b/i.test(scope)) {
    return "";
  }
  if (
    !/(?:[/*]|\b(?:src|test|tests|docs|scripts|lib|app|packages)\b|[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}\b)/.test(
      scope,
    )
  ) {
    return "";
  }
  return scope;
};

const nativeSubagentModeForRun = (_agentType: string): "read-only" => "read-only";

const workerIdForSubagent = (payload: {
  readonly session_id: string;
  readonly agent_id: string;
}): string => scopedWorkerRunId(payload.session_id, payload.agent_id);

const fallbackWorkerResult = (output: string): WorkerResult => ({
  summary: output.trim().slice(0, 500) || "worker completed with unstructured output",
  files_relevant: [],
  changes_made: [],
  commands_run: [],
  verification: [],
  risks: ["worker output did not decode as structured WorkerResult"],
  blockers: [],
  confidence: "low",
});

const reportSessionStateAppendFailure = (
  payload: Extract<NormalizedHookEvent, { readonly _tag: "SubagentStart" | "SubagentStop" }>,
  cause: unknown,
  op: string,
): Effect.Effect<void> =>
  reportHookFailure({
    kind: "state_write_failed",
    event: payload._tag,
    sessionId: payload.session_id,
    cause,
    hookSafe: true,
    context: {
      op,
      agent_id: payload.agent_id,
      agent_type: payload.agent_type,
    },
  });

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
    const workerId = workerIdForSubagent(payload);
    const existing = yield* runs.value.get(workerId);
    if (existing === null) {
      yield* runs.value.createQueued({
        worker_id: workerId,
        session_id: payload.session_id,
        agent_id: payload.agent_id,
        agent_type: payload.agent_type,
        mode: nativeSubagentModeForRun(payload.agent_type),
        prompt_hash: promptHash,
        scope: inferWorkerScope(payload.prompt),
      });
      yield* runs.value.markRunning(workerId);
      return;
    }
    if (existing.status !== "running") {
      yield* runs.value.markRunning(workerId);
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
    const workerId =
      (yield* runs.value.findByAgent(payload.session_id, payload.agent_id))?.worker_id ?? workerIdForSubagent(payload);
    if (payload.output === undefined || payload.output.trim().length === 0) {
      const reason = "worker output was missing; strict WorkerResult JSON is required";
      yield* runs.value.markBlocked(workerId, reason);
      return reason;
    }
    const config = yield* loadRuntimeConfig;
    const run = yield* runs.value.get(workerId);
    const mode = run?.mode ?? nativeSubagentModeForRun(payload.agent_type);
    const parsed = yield* parseWorkerResultText(workerId, payload.output).pipe(
      Effect.either,
    );
    if (parsed._tag === "Left") {
      const reason = "worker output did not decode as WorkerResult";
      if (config.workerRequireStructuredResult) {
        yield* runs.value.markBlocked(workerId, reason);
        return reason;
      }
      if (mode === "write-allowed") {
        const writeReason = "write worker output did not decode as WorkerResult; structured output is required to verify changes";
        yield* runs.value.markBlocked(workerId, writeReason);
        return writeReason;
      }
      yield* runs.value.complete(workerId, fallbackWorkerResult(payload.output));
      return null;
    }
    if (mode === "read-only" && parsed.right.changes_made.length > 0) {
      const reason = "read-only worker reported changes_made; inspect-only workers must not change files";
      yield* runs.value.markBlocked(
        workerId,
        reason,
      );
      return reason;
    }
    let completionMetadata: WorkerRunCompletionMetadata = {};
    if (mode === "write-allowed") {
      const hasCapturedOrReportedChanges =
        parsed.right.changes_made.length > 0 ||
        run?.patch_path !== undefined ||
        (run?.patch_changed_files?.length ?? 0) > 0;
      if (!hasCapturedOrReportedChanges) {
        const state = yield* Effect.serviceOption(SessionState);
        if (state._tag === "Some") {
          const sessionState = yield* state.value.get(payload.session_id).pipe(Effect.either);
          if (sessionState._tag === "Left") {
            const reason = "write worker completed without a captured patch and session changes could not be verified";
            yield* runs.value.markBlocked(workerId, reason);
            return reason;
          }
          if (sessionState.right.files_changed.length > 0) {
            const reason =
              "write worker reported no changes_made while the session has changed files; structured output must account for worker changes";
            yield* runs.value.markBlocked(workerId, reason);
            return reason;
          }
        }
      }
      if (parsed.right.blockers.length > 0) {
        const reason = `write worker reported blockers: ${parsed.right.blockers.slice(0, 3).join("; ")}`;
        yield* runs.value.markBlocked(workerId, reason);
        return reason;
      }
      if (hasCapturedOrReportedChanges) {
        const failedVerification = parsed.right.verification.find((check) => check.status !== "passed");
        if (parsed.right.verification.length === 0 || failedVerification !== undefined) {
          const reason =
            failedVerification === undefined
              ? "write worker changed files without verification evidence"
              : `write worker verification not passed: ${failedVerification.check}=${failedVerification.status}`;
          yield* runs.value.markBlocked(workerId, reason);
          return reason;
        }
        if (run?.patch_path === undefined) {
          const reason = "write worker reported changes without a captured isolated patch";
          yield* runs.value.markBlocked(workerId, reason);
          return reason;
        }
        completionMetadata = {
          ...(run.isolation === undefined ? {} : { isolation: run.isolation }),
          ...(run.workspace_path === undefined ? {} : { workspace_path: run.workspace_path }),
          patch_path: run.patch_path,
          ...(run.patch_changed_files === undefined ? {} : { patch_changed_files: run.patch_changed_files }),
        };
      }
    }
    yield* runs.value.complete(workerId, parsed.right, undefined, completionMetadata);
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
      }).pipe(
        Effect.as("worker stop state update failed; retry after the worker ledger is readable"),
      ),
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
        .pipe(
          Effect.catchAll((cause) =>
            reportSessionStateAppendFailure(payload, cause, "session-state.append.subagent_starts"),
          ),
        );
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
        .pipe(
          Effect.catchAll((cause) =>
            reportSessionStateAppendFailure(payload, cause, "session-state.append.subagent_stops"),
          ),
        );
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
        .pipe(
          Effect.catchAll((cause) =>
            reportSessionStateAppendFailure(payload, cause, "session-state.append.subagent_stops_blocked"),
          ),
        );
    }

    const decision: HookDecision = {
      decision: "block",
      reason: `Subagent output lacks evidence. ${role.outputContract}`,
    };
    return decision;
  });
