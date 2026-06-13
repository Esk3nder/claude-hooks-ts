/** PolicyConfig (BUILD-SPEC §5.3). JSON for zero-dep (the real repo uses YAML). */
import { join } from "node:path"
import { stateRoot, readHookOnly } from "./fsx.ts"

export interface AllowedArgv {
  argv: string[]
  cwd_policy: "workspace" | "repo-root"
  idempotent: boolean
  max_output_bytes: number
  risk: "low" | "high"
}
export interface PolicyConfig {
  schema_version: 1
  replay: { timeout_ms: number; env_allow: string[]; allowed_argv: AllowedArgv[] }
  drift: { ignore: string[] }
  recursion: { max_depth: number; max_children_per_node: number; max_concurrent: number; session_wallclock_ms: number; session_token_budget: number }
  sampling: { enabled: boolean; min_runs: number; min_acceptance: number; sample_rate: number; never_sample_risk: string[] }
  panels: { default_lenses: string[]; majority: number }
  speculative: { max_k: number; budget_token_cap: number }
}

export const DEFAULTS: PolicyConfig = {
  schema_version: 1,
  replay: { timeout_ms: 30_000, env_allow: [], allowed_argv: [] },
  drift: { ignore: [".pytest_cache/**", "coverage/**", "node_modules/.cache/**"] },
  recursion: { max_depth: 2, max_children_per_node: 8, max_concurrent: 8, session_wallclock_ms: 1_800_000, session_token_budget: 2_000_000 },
  sampling: { enabled: true, min_runs: 50, min_acceptance: 0.95, sample_rate: 0.2, never_sample_risk: ["high"] },
  panels: { default_lenses: ["correctness", "security", "edge-cases"], majority: 2 },
  speculative: { max_k: 4, budget_token_cap: 1_500_000 },
}

export function policyPath(project: string): string {
  return join(stateRoot(project), "policy.json")
}

/** Load policy. Trusted only if its sha matches the session baseline (caller checks; see trust.ts). */
export function loadPolicy(project: string): PolicyConfig {
  const raw = readHookOnly(policyPath(project))
  if (raw === null) return DEFAULTS
  try {
    const u = JSON.parse(raw) as Partial<PolicyConfig>
    return {
      schema_version: 1,
      replay: { ...DEFAULTS.replay, ...(u.replay ?? {}) },
      drift: { ...DEFAULTS.drift, ...(u.drift ?? {}) },
      recursion: { ...DEFAULTS.recursion, ...(u.recursion ?? {}) },
      sampling: { ...DEFAULTS.sampling, ...(u.sampling ?? {}) },
      panels: { ...DEFAULTS.panels, ...(u.panels ?? {}) },
      speculative: { ...DEFAULTS.speculative, ...(u.speculative ?? {}) },
    }
  } catch {
    return DEFAULTS
  }
}
