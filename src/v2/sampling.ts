/** Intensity sampling (BUILD-SPEC §8, resolves Q11 + review P1-8). Distinct labels; never spine/high-risk; reset on contradiction. */
import type { PolicyConfig } from "./config.ts"

export interface RoleStats { runs: number; accepted: number; sinceFullAudit: number; eligible: boolean }

/** Whether to skip full replay this run. Spine and high-risk are never sampled. */
export function shouldSample(args: {
  policy: PolicyConfig
  isSpine: boolean
  risk: "low" | "high"
  isPanelMember: boolean
  stats: RoleStats
  runIndex: number // deterministic position; avoids RNG
}): boolean {
  const s = args.policy.sampling
  if (!s.enabled) return false
  if (args.isSpine || args.isPanelMember) return false
  if (s.never_sample_risk.includes(args.risk)) return false
  if (!args.stats.eligible) return false
  if (args.stats.runs < s.min_runs) return false
  if (args.stats.accepted / Math.max(1, args.stats.runs) < s.min_acceptance) return false
  if (args.stats.sinceFullAudit + 1 >= Math.round(1 / s.sample_rate)) return false // force periodic full audit
  // sample 1-in-N deterministically by run index
  const n = Math.round(1 / s.sample_rate)
  return args.runIndex % n !== 0
}

/** A contradiction (replay mismatch) resets eligibility — the role goes back to every-run. */
export function onContradiction(stats: RoleStats): RoleStats {
  return { ...stats, eligible: false, sinceFullAudit: 0 }
}
export function onAccepted(stats: RoleStats, fullReplay: boolean): RoleStats {
  const runs = stats.runs + 1
  const accepted = stats.accepted + 1
  const sinceFullAudit = fullReplay ? 0 : stats.sinceFullAudit + 1
  const eligible = runs >= 0 && (stats.eligible || accepted / runs >= 0.95)
  return { runs, accepted, sinceFullAudit, eligible }
}
