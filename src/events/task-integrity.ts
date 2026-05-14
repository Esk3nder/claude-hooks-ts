import { Effect, Option } from "effect"
import { readFileSync } from "node:fs"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { NO_DECISION } from "../schema/decisions.ts"
import { findLatestISA, findProjectIsa } from "../algorithm/isa/locate.ts"
import { countCriteria } from "../algorithm/isa/criteria.ts"
import { parseSections } from "../algorithm/isa/sections.ts"
import {
  resolveActiveIsa,
  type ResolveActiveIsaRecord,
} from "../algorithm/isa/lifecycle.ts"
import { SessionState } from "../services/session-state.ts"
import { reportHookFailure } from "../services/hook-failure.ts"
import { WorkerAggregation } from "../services/worker-aggregation.ts"
import { loadRuntimeConfig } from "../services/runtime-config.ts"
import type { WorkerIntegrationSummary } from "../schema/worker-run.ts"

export const handleTaskCreated = (
  payload: HookPayload,
): Effect.Effect<HookDecision> =>
  Effect.sync(() => {
    if (payload._tag !== "TaskCreated") return NO_DECISION
    // M4: advisory only — never blocks task creation.
    return NO_DECISION
  })

const hasEvidenceItem = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0

const workerCompletionBlockReason = (
  summary: WorkerIntegrationSummary,
  finalVerificationCurrent: boolean,
): string | null => {
  if (summary.workers_total === 0) return null
  if (summary.queued > 0 || summary.running > 0 || summary.blocked > 0) {
    return [
      "Task marked complete but worker runs are still unresolved.",
      `queued=${summary.queued}`,
      `running=${summary.running}`,
      `blocked=${summary.blocked}`,
      summary.active_worker_ids.length > 0
        ? `active=${summary.active_worker_ids.join(",")}`
        : "",
      "Complete or cancel those workers before marking the parent task complete.",
    ].filter((part) => part.length > 0).join(" ")
  }
  if (summary.failed > 0) {
    return [
      "Task marked complete but worker runs failed.",
      `failed=${summary.failed}`,
      summary.failed_worker_ids.length > 0
        ? `workers=${summary.failed_worker_ids.join(",")}`
        : "",
      "Resolve or explicitly cancel failed workers before marking complete.",
    ].filter((part) => part.length > 0).join(" ")
  }
  if (summary.conflicts.length > 0) {
    return [
      "Task marked complete but worker outputs have integration conflicts.",
      `paths=${summary.conflicts.map((conflict) => conflict.path).join(",")}`,
      "Resolve conflicts and rerun final verification before marking complete.",
    ].join(" ")
  }
  if (summary.blockers.length > 0) {
    return [
      "Task marked complete but worker outputs still report blockers.",
      summary.blockers.slice(0, 3).join("; "),
    ].join(" ")
  }
  if (summary.final_verification_required && !finalVerificationCurrent) {
    return [
      "Task marked complete but integrated worker changes still need final verification.",
      `files=${summary.files_changed.join(",")}`,
      "Run the parent-workspace verification and record it before marking complete.",
    ].join(" ")
  }
  return null
}

const workerCompletionStateReadFailure = (scope: "task" | "session", id: string): string =>
  `Task marked complete but worker state could not be read (${scope}=${id}); retry after the worker ledger is readable.`

const verificationCoversWorkerIntegration = (
  summary: WorkerIntegrationSummary,
  verificationStatus: string | undefined,
  verificationAt: string | null | undefined,
): boolean => {
  if (!summary.final_verification_required) return true
  if (verificationStatus !== "passed") return false
  if (summary.latest_integrated_at === undefined) return true
  if (verificationAt === undefined || verificationAt === null) return false
  const verified = Date.parse(verificationAt)
  const integrated = Date.parse(summary.latest_integrated_at)
  return Number.isFinite(verified) && Number.isFinite(integrated) && verified >= integrated
}

const evaluateWorkerCompletion = (
  sessionId: string,
  taskId: string,
  verificationStatus: string | undefined,
  verificationAt: string | null | undefined,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const cfg = yield* loadRuntimeConfig
    if (!cfg.workersEnabled) return null
    const aggregation = yield* Effect.serviceOption(WorkerAggregation)
    if (Option.isNone(aggregation)) return null

    const parentLookup = yield* aggregation.value.summarizeParent(taskId).pipe(Effect.either)
    if (parentLookup._tag === "Left") {
      const reason = workerCompletionStateReadFailure("task", taskId)
      return yield* reportHookFailure({
        kind: "state_read_failed",
        event: "TaskCompleted",
        sessionId,
        cause: parentLookup.left,
        fallbackDecision: { decision: "block", reason },
        hookSafe: true,
        context: {
          op: "worker-aggregation.summarizeParent",
          parent_task_id: taskId,
        },
      }).pipe(Effect.as(reason))
    }
    const parentSummary = parentLookup.right
    let summary: WorkerIntegrationSummary = parentSummary
    if (summary.workers_total === 0) {
      const sessionLookup = yield* aggregation.value.summarizeSession(sessionId).pipe(Effect.either)
      if (sessionLookup._tag === "Left") {
        const reason = workerCompletionStateReadFailure("session", sessionId)
        return yield* reportHookFailure({
          kind: "state_read_failed",
          event: "TaskCompleted",
          sessionId,
          cause: sessionLookup.left,
          fallbackDecision: { decision: "block", reason },
          hookSafe: true,
          context: {
            op: "worker-aggregation.summarizeSession",
          },
        }).pipe(Effect.as(reason))
      }
      summary = sessionLookup.right
    }
    return workerCompletionBlockReason(
      summary,
      verificationCoversWorkerIntegration(summary, verificationStatus, verificationAt),
    )
  })

/**
 * Tagged result of evaluating the active ISA at `cwd` against a
 * TaskCompleted claim. One read + one parse per invocation.
 *
 * - `missing`     — no ISA found (or file vanished between resolve and read).
 *                   Native AC/evidence check governs.
 * - `block`       — ISA exists and contradicts a completion claim (unchecked
 *                   ISCs or empty Verification body). Surface the reason
 *                   verbatim to the model.
 * - `sufficient`  — ISA has at least one ISC, all checked, AND a non-empty
 *                   Verification body. The ISA itself is the evidence and
 *                   the gate may pass without native AC/evidence.
 * - `insufficient`— ISA file exists but has zero checkbox-style ISCs (a
 *                   prose-only stub). It is NOT sufficient evidence on its
 *                   own; fall through to the native AC/evidence check so a
 *                   bare stub can't be used to bypass the gate.
 */
type IsaState =
  | { readonly kind: "missing" }
  | { readonly kind: "block"; readonly reason: string }
  | { readonly kind: "sufficient" }
  | { readonly kind: "insufficient" }

/**
 * Resolve the active ISA (project ISA wins over latest task ISA, scoped to
 * `record` when present) and classify its state in one pass.
 *
 * `record === undefined` keeps the legacy project-or-latest lookup; an
 * explicit `null` is treated identically to `undefined` so callers that
 * already coalesce null/undefined upstream don't have to do it twice.
 */
const evaluateIsa = (
  cwd: string,
  record: ResolveActiveIsaRecord | null | undefined,
): IsaState => {
  const scoped =
    record !== undefined && record !== null
      ? resolveActiveIsa({ sessionRoot: cwd, record })
      : (findProjectIsa(cwd) ?? findLatestISA(cwd))
  if (scoped === null) return { kind: "missing" }
  // existsSync is racy vs deletion, so don't gate on it — let readFileSync
  // be the single source of truth and treat any failure as "missing".
  let content: string
  try {
    content = readFileSync(scoped, "utf-8")
  } catch {
    return { kind: "missing" }
  }

  const counts = countCriteria(content)
  if (counts.total === 0) return { kind: "insufficient" }

  if (counts.checked < counts.total) {
    return {
      kind: "block",
      reason:
        `Task marked complete but the active ISA at ${scoped} still has ` +
        `${counts.total - counts.checked} of ${counts.total} ISC criteria ` +
        `unchecked. Verify and check the remaining ISCs before declaring ` +
        `the task complete, OR roll the ISA's phase back to a non-complete ` +
        `state.`,
    }
  }

  const sections = parseSections(content)
  const verificationBody = sections.get("Verification")?.body.trim() ?? ""
  if (verificationBody.length === 0) {
    return {
      kind: "block",
      reason:
        `Task marked complete but the active ISA at ${scoped} has no ` +
        `## Verification section evidence. Add one entry per ISC (see ` +
        `IsaFormat.md:343-350) before declaring complete.`,
    }
  }

  return { kind: "sufficient" }
}

export const handleTaskCompleted = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, SessionState> =>
  Effect.gen(function* () {
    if (payload._tag !== "TaskCompleted") return NO_DECISION

    // Acceptance/evidence may arrive top-level (rich harness contract) or
    // under payload.metadata (current Claude Code TaskUpdate surface, which
    // has no first-class AC/evidence parameters). Read from either; runtime
    // checks below do the narrowing.
    const meta = payload.metadata as
      | { acceptance_criteria?: unknown; evidence?: unknown }
      | undefined

    const ac = payload.acceptance_criteria ?? meta?.acceptance_criteria
    const ev = payload.evidence ?? meta?.evidence
    const missingAc = typeof ac !== "string" || ac.trim().length === 0
    const missingEv = !Array.isArray(ev) || !ev.some(hasEvidenceItem)

    // ISC-evidence requirement (slice 3c). Runs FIRST so ISA-side gaps
    // surface their specific guidance instead of a generic field message.
    //
    // ISA identity is rooted at the frozen session_root, not the current
    // shell cwd. After a Bash `cd`, the shell may sit far from the
    // project, but the active ISA is still the one under the project.
    const state = yield* SessionState
    const sid = payload.session_id
    const recordResult = yield* state.get(sid).pipe(Effect.either)
    if (recordResult._tag === "Left") {
      const fallback: HookDecision = {
        decision: "block",
        reason: `Task marked complete but session state could not be read (session=${sid}); retry after state is readable.`,
      }
      yield* reportHookFailure({
        kind: "state_read_failed",
        event: "TaskCompleted",
        sessionId: sid,
        cause: recordResult.left,
        fallbackDecision: fallback,
        hookSafe: true,
        context: { op: "session-state.get" },
      })
      return fallback
    }
    const record = recordResult.right
    const currentCwd =
      typeof payload.cwd === "string" && payload.cwd.length > 0
        ? payload.cwd
        : process.cwd()
    const sessionRoot = record.session_root ?? currentCwd
    const workerBlockReason = yield* evaluateWorkerCompletion(
      sid,
      payload.task_id,
      record.verification_status,
      record.verification_at,
    )
    if (workerBlockReason !== null) {
      return { decision: "block", reason: workerBlockReason } satisfies HookDecision
    }

    const isa = evaluateIsa(sessionRoot, record)
    if (isa.kind === "block") {
      return { decision: "block", reason: isa.reason } satisfies HookDecision
    }

    if (!missingAc && !missingEv) return NO_DECISION

    // A `sufficient` ISA (counts.total > 0, all checked, Verification
    // non-empty) IS the evidence — duplicating AC/evidence on the
    // payload is redundant and unsatisfiable through Claude Code's
    // TaskUpdate (which drops user-provided `metadata`).
    if (isa.kind === "sufficient") return NO_DECISION

    // `missing` (no ISA) or `insufficient` (ISA stub with no checkbox
    // ISCs) means the ISA can't shoulder the evidence burden. The
    // native AC/evidence requirement is opt-in via signal:
    //
    //   - A payload that shows AC/evidence intent (top-level or under
    //     metadata) gets the strict check, so harness-bridge callers
    //     that provide one half of the pair get a useful error rather
    //     than silent acceptance.
    //   - An ISA in `insufficient` state ALSO triggers the strict
    //     check: a prose-only stub at cwd must not become a bypass.
    //   - A bare documented-shape payload (no signal, no ISA at all)
    //     is lightweight bookkeeping and passes through.
    const hasAcSignal =
      payload.acceptance_criteria !== undefined ||
      meta?.acceptance_criteria !== undefined
    const hasEvSignal =
      payload.evidence !== undefined || meta?.evidence !== undefined
    const insufficientIsa = isa.kind === "insufficient"
    if (!hasAcSignal && !hasEvSignal && !insufficientIsa) return NO_DECISION

    return {
      decision: "block",
      reason:
        "Task completion requires acceptance_criteria and evidence fields. Provide both before marking complete.",
    } satisfies HookDecision
  })
