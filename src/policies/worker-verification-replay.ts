/**
 * Worker behavioral verification replay (US-1c).
 *
 * Workers self-report a `verification[]` array as part of their structured
 * output (`src/schema/worker-run.ts` WorkerVerification). Each entry is
 * `{ check, status: "passed" | "failed" | "not_run", evidence }`. Today
 * the parent process accepts those claims at face value — a worker can
 * claim `typecheck: passed` without ever running tsc.
 *
 * This policy closes the gap. The wrapper in
 * `events/subagent-scope-gate.ts:handleSubagentStop` loads the registered
 * probes, re-runs them in the parent process, and feeds the worker's
 * claims AND the replay results into this pure decision function.
 *
 * Decision rules:
 *   - No claims → passthrough (nothing to verify)
 *   - Only `not_run` claims → passthrough (worker honestly didn't run)
 *   - Claim with NO matching replay → passthrough (probe missing,
 *     unverifiable is not unverified — surface via log elsewhere)
 *   - Claim agrees with replay → passthrough
 *   - Any non-`not_run` claim DISAGREES with replay → block, listing only
 *     the disagreeing checks
 *
 * Pure function — no I/O. Replay execution is the wrapper's job.
 */

export interface WorkerVerificationClaim {
  readonly check: string
  readonly status: "passed" | "failed" | "not_run"
  readonly evidence: string
}

export interface ReplayResult {
  readonly check: string
  readonly passed: boolean
}

export interface VerificationReplayInput {
  readonly claims: ReadonlyArray<WorkerVerificationClaim>
  readonly replays: ReadonlyArray<ReplayResult>
}

export type VerificationReplayVerdict =
  | { readonly kind: "passthrough" }
  | { readonly kind: "block"; readonly reason: string }

interface Disagreement {
  readonly check: string
  readonly claimed: "passed" | "failed"
  readonly replayPassed: boolean
}

const findDisagreements = (
  input: VerificationReplayInput,
): ReadonlyArray<Disagreement> => {
  const replayByCheck = new Map<string, boolean>()
  for (const r of input.replays) replayByCheck.set(r.check, r.passed)

  const seen = new Set<string>()
  const out: Disagreement[] = []
  for (const claim of input.claims) {
    if (claim.status === "not_run") continue
    if (seen.has(claim.check + ":" + claim.status)) continue
    seen.add(claim.check + ":" + claim.status)
    const replayPassed = replayByCheck.get(claim.check)
    if (replayPassed === undefined) continue
    const claimPassed = claim.status === "passed"
    if (claimPassed !== replayPassed) {
      out.push({ check: claim.check, claimed: claim.status, replayPassed })
    }
  }
  return out
}

const formatDisagreement = (d: Disagreement): string =>
  `${d.check}: worker claimed ${d.claimed}, replay ${d.replayPassed ? "passed" : "failed"}`

export const evaluateVerificationReplay = (
  input: VerificationReplayInput,
): VerificationReplayVerdict => {
  const disagreements = findDisagreements(input)
  if (disagreements.length === 0) return { kind: "passthrough" }
  const lines = disagreements.map(formatDisagreement).join("; ")
  return {
    kind: "block",
    reason: `verification_replay_failed: ${lines}. The worker's self-reported verification disagreed with a re-run of the probe in the parent process. Inspect the disagreement and resubmit.`,
  }
}
