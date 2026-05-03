/**
 * Common types for policy modules.
 *
 * Policies are pure functions: given a parsed tool input, return a
 * structured decision. The orchestrator (`pretool-policy.ts`) runs all
 * applicable policies and reduces them via `deny > ask > allow`.
 */

export type PolicyDecision =
  | { readonly kind: "deny"; readonly reason: string; readonly suggested?: string }
  | { readonly kind: "ask"; readonly reason: string }
  | { readonly kind: "allow"; readonly reason?: string }
  | { readonly kind: "passthrough" }

/** Severity ordering used by the reducer. Higher wins. */
export const SEVERITY: Record<PolicyDecision["kind"], number> = {
  passthrough: 0,
  allow: 1,
  ask: 2,
  deny: 3,
}

/** Reduce a list of policy results to a single most-restrictive decision. */
export const reducePolicies = (
  results: ReadonlyArray<PolicyDecision>,
): PolicyDecision => {
  let best: PolicyDecision = { kind: "passthrough" }
  const reasons: string[] = []
  let suggested: string | undefined
  for (const r of results) {
    if (r.kind === "passthrough") continue
    if (SEVERITY[r.kind] > SEVERITY[best.kind]) {
      best = r
      reasons.length = 0
      if ("reason" in r && r.reason) reasons.push(r.reason)
      if (r.kind === "deny" && r.suggested) suggested = r.suggested
    } else if (SEVERITY[r.kind] === SEVERITY[best.kind] && r.kind !== "allow") {
      if ("reason" in r && r.reason) reasons.push(r.reason)
      if (r.kind === "deny" && r.suggested && !suggested) suggested = r.suggested
    }
  }
  if (best.kind === "deny") {
    return suggested !== undefined
      ? { kind: "deny", reason: reasons.join("; "), suggested }
      : { kind: "deny", reason: reasons.join("; ") }
  }
  if (best.kind === "ask") return { kind: "ask", reason: reasons.join("; ") }
  return best
}
