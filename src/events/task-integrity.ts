import { Effect } from "effect"
import { existsSync, readFileSync } from "node:fs"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { findLatestISA, findProjectIsa } from "../algorithm/isa/locate.ts"
import { countCriteria } from "../algorithm/isa/criteria.ts"
import { parseSections } from "../algorithm/isa/sections.ts"

export const handleTaskCreated = (
  payload: HookPayload,
): Effect.Effect<HookDecision> =>
  Effect.sync(() => {
    if (payload._tag !== "TaskCreated") return SAFE_DEFAULT
    // M4: advisory only — never blocks task creation.
    return SAFE_DEFAULT
  })

/**
 * Inspect the active ISA (project ISA wins over latest task ISA) and decide
 * whether ISC-side state contradicts a TaskCompleted claim. Returns a
 * model-actionable block reason or null.
 *
 * Two block conditions:
 * 1. Active ISA has unchecked ISCs — task can't really be done if the
 * written-down done-criteria aren't met.
 * 2. Active ISA has at least one ISC AND the `## Verification` section
 * is empty / missing — Verification names the evidence per ISC, and
 * declaring done with no written verification is the
 * "TaskCompleted-without-evidence" anti-pattern this gate prevents.
 *
 * Returns null when no ISA is found at cwd — the gate is opt-in via ISA
 * presence (same convention as the Stop ISA-gate).
 */
const checkIsaEvidence = (cwd: string): string | null => {
  const isaPath = findProjectIsa(cwd) ?? findLatestISA(cwd)
  if (isaPath === null) return null
  if (!existsSync(isaPath)) return null

  let content: string
  try {
    content = readFileSync(isaPath, "utf-8")
  } catch {
    return null
  }

  const counts = countCriteria(content)
  if (counts.total > 0 && counts.checked < counts.total) {
    return (
      `Task marked complete but the active ISA at ${isaPath} still has ` +
      `${counts.total - counts.checked} of ${counts.total} ISC criteria ` +
      `unchecked. Verify and check the remaining ISCs before declaring ` +
      `the task complete, OR roll the ISA's phase back to a non-complete ` +
      `state.`
    )
  }

  if (counts.total > 0) {
    const sections = parseSections(content)
    const verificationBody = sections.get("Verification")?.body.trim() ?? ""
    if (verificationBody.length === 0) {
      return (
        `Task marked complete but the active ISA at ${isaPath} has no ` +
        `## Verification section evidence. Add one entry per ISC (see ` +
        `IsaFormat.md:343-350) before declaring complete.`
      )
    }
  }

  return null
}

export const handleTaskCompleted = (
  payload: HookPayload,
): Effect.Effect<HookDecision> =>
  Effect.sync(() => {
    if (payload._tag !== "TaskCompleted") return SAFE_DEFAULT

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
    const missingEv = !Array.isArray(ev) || ev.length === 0

    // ISC-evidence requirement (slice 3c). Runs FIRST so ISA-side gaps
    // surface their specific guidance instead of a generic field message.
    const cwd =
      typeof payload.cwd === "string" && payload.cwd.length > 0
        ? payload.cwd
        : process.cwd()
    const isaBlock = checkIsaEvidence(cwd)
    if (isaBlock !== null) {
      return {
        decision: "block",
        reason: isaBlock,
      } satisfies HookDecision
    }

    if (!missingAc && !missingEv) return SAFE_DEFAULT
    return {
      decision: "block",
      reason:
        "Task completion requires acceptance_criteria and evidence fields. Provide both before marking complete.",
    } satisfies HookDecision
  })
