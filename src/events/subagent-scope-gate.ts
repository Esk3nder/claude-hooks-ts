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
import { WORKER_CONTRACT_MARKER } from "../policies/worker-contract.ts";
import {
  evaluateVerificationReplay,
  type ReplayResult,
  type WorkerVerificationClaim,
} from "../policies/worker-verification-replay.ts";
import {
  loadProbes,
  resolveProbe,
  runProbe,
  type Probe,
} from "../algorithm/isa/probes.ts";
import type { CriterionEntry } from "../algorithm/isa/criteria.ts";

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

const workerContractKey = (key: string): string => `${key}:worker-contract`;

const hasWorkerContractMarker = (prompt: string | undefined): boolean =>
  typeof prompt === "string" && prompt.includes(WORKER_CONTRACT_MARKER);

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
    if (!hasWorkerContractMarker(payload.prompt)) return;
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

interface WorkerStopRecord {
  readonly active: boolean;
  readonly cancelled: boolean;
  readonly blockReason: string | null;
  /**
   * P0-3: the WorkerResult parsed from `payload.output` when the parse
   * succeeded, otherwise null. Returned alongside the other fields so
   * `handleSubagentStop` can drive verification replay off this value
   * directly rather than re-parsing the same string a second time. The
   * old re-parse path could fail (the surrounding code anticipated it
   * with a warning + skip) and silently bypass replay for write
   * workers — closed by threading the parsed result through here.
   */
  readonly parsedResult: WorkerResult | null;
}

/**
 * US-1c — re-run the worker's claimed verification probes in the parent
 * process. Returns one ReplayResult per claim whose `check` name resolves
 * to a probe in the registry. Claims with no matching probe are silently
 * absent from the result (treated as "unverifiable" by the pure policy,
 * not blocking).
 *
 * Synthesizes a CriterionEntry per claim so probes designed for ISC
 * verification can be invoked unchanged; the synthetic id is the check
 * name itself.
 */
const replayWorkerVerification = (
  claims: ReadonlyArray<WorkerVerificationClaim>,
  cwd: string,
): Effect.Effect<ReadonlyArray<ReplayResult>> =>
  Effect.gen(function* () {
    if (claims.length === 0) return [];
    const registry: Readonly<Record<string, Probe>> = yield* Effect.promise(
      () => loadProbes(cwd),
    );
    // Run unique check names only — avoid double-running a probe when the
    // worker reported the same check twice — and build the probe-run
    // Effects up-front so we can dispatch them concurrently.
    const seen = new Set<string>();
    const probeRuns: Array<Effect.Effect<ReplayResult>> = [];
    for (const claim of claims) {
      if (seen.has(claim.check)) continue;
      seen.add(claim.check);
      const probe = registry[claim.check];
      if (probe === undefined) continue;
      const resolved = resolveProbe(probe);
      const criterion: CriterionEntry = {
        id: claim.check,
        description: "worker verification replay",
        type: "criterion",
        status: "pending",
      };
      const checkName = claim.check;
      probeRuns.push(
        Effect.map(
          runProbe(resolved.fn, criterion, resolved.timeoutMs),
          (passed) => ({ check: checkName, passed } as ReplayResult),
        ),
      );
    }
    // Parallel: each probe is independent. Worst-case wall-clock is the
    // slowest single probe's timeoutMs rather than the sum.
    const out = yield* Effect.all(probeRuns, { concurrency: "unbounded" });
    return out;
  });

const recordWorkerStop = (
  payload: Extract<NormalizedHookEvent, { readonly _tag: "SubagentStop" }>,
): Effect.Effect<WorkerStopRecord> =>
  Effect.gen(function* () {
    const runs = yield* Effect.serviceOption(WorkerRuns);
    if (runs._tag === "None") return { active: false, cancelled: false, blockReason: null, parsedResult: null };
    const run = yield* runs.value.findByAgent(payload.session_id, payload.agent_id);
    if (run === null) return { active: false, cancelled: false, blockReason: null, parsedResult: null };
    const workerId = run.worker_id;
    if (payload.output === undefined || payload.output.trim().length === 0) {
      const reason = "worker stopped without output; treating as cancelled";
      yield* runs.value.cancel(workerId, reason);
      return { active: true, cancelled: true, blockReason: null, parsedResult: null };
    }
    const config = yield* loadRuntimeConfig;
    const mode = run?.mode ?? nativeSubagentModeForRun(payload.agent_type);
    const parsed = yield* parseWorkerResultText(workerId, payload.output).pipe(
      Effect.either,
    );
    if (parsed._tag === "Left") {
      const reason = "worker output did not decode as WorkerResult";
      if (config.workerRequireStructuredResult) {
        yield* runs.value.markBlocked(workerId, reason);
        return { active: true, cancelled: false, blockReason: reason, parsedResult: null };
      }
      if (mode === "write-allowed") {
        const writeReason = "write worker output did not decode as WorkerResult; structured output is required to verify changes";
        yield* runs.value.markBlocked(workerId, writeReason);
        return { active: true, cancelled: false, blockReason: writeReason, parsedResult: null };
      }
      yield* runs.value.complete(workerId, fallbackWorkerResult(payload.output));
      return { active: true, cancelled: false, blockReason: null, parsedResult: null };
    }
    if (mode === "read-only" && parsed.right.changes_made.length > 0) {
      const reason = "read-only worker reported changes_made; inspect-only workers must not change files";
      yield* runs.value.markBlocked(
        workerId,
        reason,
      );
      return { active: true, cancelled: false, blockReason: reason, parsedResult: parsed.right };
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
            return { active: true, cancelled: false, blockReason: reason, parsedResult: parsed.right };
          }
          if (sessionState.right.files_changed.length > 0) {
            const reason =
              "write worker reported no changes_made while the session has changed files; structured output must account for worker changes";
            yield* runs.value.markBlocked(workerId, reason);
            return { active: true, cancelled: false, blockReason: reason, parsedResult: parsed.right };
          }
        }
      }
      if (parsed.right.blockers.length > 0) {
        const reason = `write worker reported blockers: ${parsed.right.blockers.slice(0, 3).join("; ")}`;
        yield* runs.value.markBlocked(workerId, reason);
        return { active: true, cancelled: false, blockReason: reason, parsedResult: parsed.right };
      }
      if (hasCapturedOrReportedChanges) {
        const failedVerification = parsed.right.verification.find((check) => check.status !== "passed");
        if (parsed.right.verification.length === 0 || failedVerification !== undefined) {
          const reason =
            failedVerification === undefined
              ? "write worker changed files without verification evidence"
              : `write worker verification not passed: ${failedVerification.check}=${failedVerification.status}`;
          yield* runs.value.markBlocked(workerId, reason);
          return { active: true, cancelled: false, blockReason: reason, parsedResult: parsed.right };
        }
        if (run?.patch_path === undefined) {
          const reason = "write worker reported changes without a captured isolated patch";
          yield* runs.value.markBlocked(workerId, reason);
          return { active: true, cancelled: false, blockReason: reason, parsedResult: parsed.right };
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
    return { active: true, cancelled: false, blockReason: null, parsedResult: parsed.right };
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
        Effect.as({
          active: true,
          cancelled: false,
          blockReason: "worker stop state update failed; retry after the worker ledger is readable",
          parsedResult: null,
        }),
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
    const hasContract = hasWorkerContractMarker(payload.prompt);
    if (hasContract && !prev.subagent_starts.includes(workerContractKey(key))) {
      yield* state
        .append(payload.session_id, "subagent_starts", workerContractKey(key))
        .pipe(
          Effect.catchAll((cause) =>
            reportSessionStateAppendFailure(payload, cause, "session-state.append.subagent_starts_contract"),
          ),
        );
    }
    yield* recordWorkerStart(payload);

    if (!hasContract) return NO_DECISION;

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
    const workerStop = yield* recordWorkerStop(payload);
    if (workerStop.blockReason !== null) {
      return {
        decision: "block",
        reason: workerStop.blockReason,
      };
    }
    if (workerStop.cancelled) return NO_DECISION;

    // US-1c: replay the worker's claimed verification probes in the
    // parent process. Disagreements block the SubagentStop. Missing
    // probes are unverifiable, not unverified — they pass through.
    //
    // P0-3: use the WorkerResult that `recordWorkerStop` already parsed
    // rather than re-parsing the same string a second time. The old
    // re-parse path had a logged-and-skipped branch on parse failure
    // that silently bypassed verification replay (for write workers
    // too); threading the result through `WorkerStopRecord` makes that
    // branch unreachable.
    if (
      workerStop.parsedResult !== null &&
      workerStop.parsedResult.verification.length > 0
    ) {
      const cwd =
        typeof payload.cwd === "string" && payload.cwd.length > 0
          ? payload.cwd
          : process.cwd();
      const claims: ReadonlyArray<WorkerVerificationClaim> =
        workerStop.parsedResult.verification;
      const replays = yield* replayWorkerVerification(claims, cwd);
      const verdict = evaluateVerificationReplay({ claims, replays });
      if (verdict.kind === "block") {
        return { decision: "block", reason: verdict.reason };
      }
    }

    const workerContractActive =
      workerStop.active || prev.subagent_starts.includes(workerContractKey(key));
    if (!workerContractActive) return NO_DECISION;

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
