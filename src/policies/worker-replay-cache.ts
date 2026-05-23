import type { WorkerResult, WorkerRun } from "../schema/worker-run.ts"
import {
  CURRENT_WORKER_CONTRACT_HASH,
  CURRENT_WORKER_CONTRACT_VERSION,
} from "./worker-contract.ts"

export interface WorkerReplayContract {
  readonly contract_version?: string
  readonly contract_hash?: string
}

export type WorkerReplayRun = WorkerRun & WorkerReplayContract

export interface WorkerReplayCandidateQuery extends WorkerReplayContract {
  readonly prompt_hash: string
  readonly scope: string
  readonly agent_type: string
}

export type WorkerReplayRejectReason =
  | "identity_mismatch"
  | "contract_mismatch"
  | "not_completed"
  | "unstructured_result"
  | "noisy_result"
  | "read_only_changed_files"
  | "verification_not_passed"
  | "unsupported_mode"

export type WorkerReplayCandidateDecision =
  | {
      readonly kind: "auto-replayable"
      readonly run: WorkerReplayRun
      readonly result: WorkerResult
    }
  | {
      readonly kind: "advisory-only"
      readonly run: WorkerReplayRun
      readonly result: WorkerResult
      readonly reason: "write_allowed_prior_result"
    }
  | {
      readonly kind: "rejected"
      readonly reason: WorkerReplayRejectReason
      readonly detail: string
    }

const workerResult = (run: WorkerReplayRun): WorkerResult | undefined =>
  run.result ?? run.output

const hasPatchArtifact = (run: WorkerReplayRun): boolean =>
  run.patch_path !== undefined ||
  (run.patch_changed_files?.length ?? 0) > 0

const hasReportedChanges = (result: WorkerResult): boolean =>
  result.changes_made.length > 0

const resultHasNonPassedVerification = (result: WorkerResult): boolean =>
  result.verification.some((check) => check.status !== "passed")

const resultSatisfiesRequiredVerification = (result: WorkerResult): boolean => {
  if (resultHasNonPassedVerification(result)) return false
  return (
    result.verification.length > 0 &&
    result.verification.every((check) => check.status === "passed")
  )
}

const resultIsNoisy = (run: WorkerReplayRun, result: WorkerResult): boolean =>
  run.failure_reason !== undefined ||
  run.blocked_reason !== undefined ||
  result.risks.length > 0 ||
  result.blockers.length > 0 ||
  result.commands_run.some((command) =>
    command.exit_code !== undefined && command.exit_code !== 0,
  ) ||
  resultHasNonPassedVerification(result)

const reject = (
  reason: WorkerReplayRejectReason,
  detail: string,
): WorkerReplayCandidateDecision => ({
  kind: "rejected",
  reason,
  detail,
})

const contractsMatch = (
  run: WorkerReplayRun,
  query: WorkerReplayCandidateQuery,
): boolean => {
  const contractVersion = query.contract_version ?? CURRENT_WORKER_CONTRACT_VERSION
  const contractHash = query.contract_hash ?? CURRENT_WORKER_CONTRACT_HASH
  return run.contract_version === contractVersion && run.contract_hash === contractHash
}

export const evaluateWorkerReplayCandidate = (
  run: WorkerReplayRun,
  query: WorkerReplayCandidateQuery,
): WorkerReplayCandidateDecision => {
  if (
    run.prompt_hash !== query.prompt_hash ||
    run.scope !== query.scope ||
    run.agent_type !== query.agent_type
  ) {
    return reject(
      "identity_mismatch",
      "worker run prompt_hash, scope, and agent_type must match the replay query",
    )
  }

  if (!contractsMatch(run, query)) {
    return reject(
      "contract_mismatch",
      "worker run contract version/hash does not match the replay query",
    )
  }

  if (run.status !== "completed") {
    return reject("not_completed", "worker run must be completed")
  }

  if (run.result_unstructured === true) {
    return reject(
      "unstructured_result",
      "worker run completed from unstructured fallback output",
    )
  }

  const result = workerResult(run)
  if (result === undefined) {
    return reject("unstructured_result", "worker run has no structured result")
  }

  if (resultIsNoisy(run, result)) {
    return reject(
      "noisy_result",
      "worker run has blockers, risks, failed commands, or failed verification",
    )
  }

  if (!resultSatisfiesRequiredVerification(result)) {
    return reject(
      "verification_not_passed",
      "worker run verification did not pass or was required but absent",
    )
  }

  if (run.mode === "write-allowed") {
    return {
      kind: "advisory-only",
      run,
      result,
      reason: "write_allowed_prior_result",
    }
  }

  if (run.mode !== "read-only") {
    return reject("unsupported_mode", "worker run mode is not replayable")
  }

  if (hasReportedChanges(result) || hasPatchArtifact(run)) {
    return reject(
      "read_only_changed_files",
      "read-only worker run reported changes or patch artifacts",
    )
  }

  return {
    kind: "auto-replayable",
    run,
    result,
  }
}

export const isWorkerRunSafeForAutoReplay = (
  run: WorkerReplayRun,
  query: WorkerReplayCandidateQuery,
): boolean =>
  evaluateWorkerReplayCandidate(run, query).kind === "auto-replayable"
