/** Shared contracts for the full claude-hooks build (BUILD-SPEC §5). */

export type Role = "scout" | "implementer" | "skeptic"
export const ROLES: readonly Role[] = ["scout", "implementer", "skeptic"]

/**
 * Map a host agent_type to a v2 role ONLY when it denotes a recognized restrictive worker (N1).
 * v2 roles spawned under their own name map directly; the host's read-only `Explore` maps to scout.
 * Anything else (general-purpose, Plan, custom names) returns null — it is NOT a constrained v2 worker,
 * so the capability gate must neither constrain it nor throw on it. The real role of a v2 worker comes
 * from its BRIEF, not the host type; this is only the fallback when no brief is registered.
 */
const HOST_ROLE_ALIASES: Record<string, Role> = { Explore: "scout" }
export function coerceRole(hostType: string): Role | null {
  if ((ROLES as readonly string[]).includes(hostType)) return hostType as Role
  return HOST_ROLE_ALIASES[hostType] ?? null
}

/** Tool capability sets per role (BUILD-SPEC §6.1 — capabilities narrow with depth). */
export const ROLE_CAPS: Record<Role, readonly string[]> = {
  scout: ["Read", "Grep", "Glob"],
  implementer: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
  skeptic: ["Read", "Grep", "Glob", "Bash"],
}

export type Outcome =
  | "accepted_verified"
  | "accepted_sampled"
  | "audit_required"
  | "rejected"
  | "soft_failed"
  | "well_formed"

export interface Acceptance {
  argv: string[]
  cwd: string
  replay: "required" | "advisory" | "none"
  idempotent: boolean
}

export interface WorkerBrief {
  schema_version: 1
  role: Role
  label: string
  parent_run_id?: string | null
  isa_path?: string | null
  isc_id?: string | null
  files_in_scope?: string[]
  lens?: "correctness" | "security" | "edge-cases" | "repro" | null
  warm?: boolean
  strategy?: { mode: "single" | "speculative"; k: number }
  acceptance?: Acceptance | null
  allowed_reproduction?: Array<{ argv: string[]; cwd: string }>
  risk?: "low" | "high"
}

export interface Workspace {
  root: string
  base_ref?: string
  isolation?: "worktree" | "shared"
}

export interface Verification {
  argv: string[]
  cwd: string
  exit_code: number
  output_tail?: string
}

export interface ImplementerResult {
  label: string
  status: "done" | "blocked"
  summary: string
  workspace: Workspace
  changed_files: string[]
  verification?: Verification | null
  blockers: string[]
}

export interface ScoutResult {
  label: string
  question: string
  findings: Array<{ claim: string; evidence: Evidence[]; confidence: "high" | "medium" | "low" }>
  coverage: { examined: string[]; not_examined: string[] }
  unknowns: string[]
}

export interface SkepticResult {
  label: string
  claim: string
  verdict: "confirmed" | "refuted" | "inconclusive"
  workspace: { root: string }
  evidence: Evidence[]
  reproduction?: { argv: string[]; cwd: string; expected_exit_code?: number } | null
  caveats: string[]
}

export interface Evidence {
  file: string
  start_line: number
  end_line: number
  excerpt: string
}

export interface Validation<T> {
  ok: boolean
  errors: string[]
  value: T | null
}

export const ok = <T>(value: T): Validation<T> => ({ ok: true, errors: [], value })
export const err = <T>(errors: string[]): Validation<T> => ({ ok: false, errors, value: null })
