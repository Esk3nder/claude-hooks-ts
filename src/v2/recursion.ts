/** Recursion: authority matrix, caps, cycle prevention (BUILD-SPEC §6, resolves review P1-6). */
import { ROLE_CAPS, type Role } from "./types.ts"
import type { PolicyConfig } from "./config.ts"

export interface NodeAuthority { tools: string[]; may_spawn: boolean }

/** Child authority = role caps ∩ parent authority. Capabilities narrow with depth, never widen. */
export function deriveAuthority(role: Role, parent: NodeAuthority | null): NodeAuthority {
  const roleCaps = ROLE_CAPS[role]
  const tools = parent === null ? [...roleCaps] : roleCaps.filter((c) => parent.tools.includes(c))
  // skeptic is leaf-only (verification stays undelegated); scout may spawn (read-only fan-out); implementer may spawn.
  const may_spawn = role !== "skeptic"
  return { tools, may_spawn }
}

export type SpawnDecision = { allow: true } | { allow: false; reason: string }

export interface SpawnContext {
  parentAuthority: NodeAuthority
  parentDepth: number
  childRole: Role
  childTools: string[] // capability the child would need (role caps)
  ancestryLabels: string[]
  childLabel: string
  childrenOfParent: number
  concurrentInSession: number
  sessionTokensSpent: number
  sessionWallclockMs: number
  policy: PolicyConfig
}

/** Decide whether a parent may spawn a child. Deny is a PreToolUse deny on the Agent call (security-class). */
export function canSpawn(c: SpawnContext): SpawnDecision {
  if (!c.parentAuthority.may_spawn) return { allow: false, reason: `${c.childRole} parent may not spawn (skeptic is leaf-only)` }
  // capability widening check: child needs a tool the parent lacks
  const widened = c.childTools.filter((t) => !c.parentAuthority.tools.includes(t))
  if (widened.length > 0) return { allow: false, reason: `capability widening denied: child needs ${widened.join(",")} parent lacks` }
  if (c.parentDepth + 1 > c.policy.recursion.max_depth) return { allow: false, reason: `max_depth ${c.policy.recursion.max_depth} exceeded` }
  if (c.ancestryLabels.includes(c.childLabel)) return { allow: false, reason: `cycle: ${c.childLabel} in ancestry` }
  if (c.childrenOfParent + 1 > c.policy.recursion.max_children_per_node) return { allow: false, reason: `max_children_per_node exceeded` }
  if (c.concurrentInSession + 1 > c.policy.recursion.max_concurrent) return { allow: false, reason: `max_concurrent exceeded` }
  if (c.sessionTokensSpent > c.policy.recursion.session_token_budget) return { allow: false, reason: `session_token_budget exhausted` }
  if (c.sessionWallclockMs > c.policy.recursion.session_wallclock_ms) return { allow: false, reason: `session_wallclock exhausted` }
  return { allow: true }
}
