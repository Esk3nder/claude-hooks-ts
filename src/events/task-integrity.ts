import { Effect } from "effect"
import { readFileSync } from "node:fs"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { findLatestISA, findProjectIsa } from "../algorithm/isa/locate.ts"
import { countCriteria } from "../algorithm/isa/criteria.ts"
import { parseSections } from "../algorithm/isa/sections.ts"
import {
  resolveActiveIsa,
  type ResolveActiveIsaRecord,
} from "../algorithm/isa/lifecycle.ts"
import { SessionState } from "../services/session-state.ts"

export const handleTaskCreated = (
  payload: HookPayload,
): Effect.Effect<HookDecision> =>
  Effect.sync(() => {
    if (payload._tag !== "TaskCreated") return SAFE_DEFAULT
    // M4: advisory only — never blocks task creation.
    return SAFE_DEFAULT
  })

const hasEvidenceItem = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0

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
    const missingEv = !Array.isArray(ev) || !ev.some(hasEvidenceItem)

    // ISC-evidence requirement (slice 3c). Runs FIRST so ISA-side gaps
    // surface their specific guidance instead of a generic field message.
    //
    // ISA identity is rooted at the frozen session_root, not the current
    // shell cwd. After a Bash `cd`, the shell may sit far from the
    // project, but the active ISA is still the one under the project.
    const state = yield* SessionState
    const sid = payload.session_id
    const record = yield* state
      .get(sid)
      .pipe(
        Effect.catchAll((cause) => {
          process.stderr.write(
            `[TaskCompleted] session-state op=get failed: sid=${sid} cause=${String(cause).slice(0, 160)}\n`,
          )
          return Effect.succeed(null)
        }),
      )
    const currentCwd =
      typeof payload.cwd === "string" && payload.cwd.length > 0
        ? payload.cwd
        : process.cwd()
    const sessionRoot = record?.session_root ?? currentCwd
    const isa = evaluateIsa(sessionRoot, record)
    if (isa.kind === "block") {
      return { decision: "block", reason: isa.reason } satisfies HookDecision
    }

    if (!missingAc && !missingEv) return SAFE_DEFAULT

    // A `sufficient` ISA (counts.total > 0, all checked, Verification
    // non-empty) IS the evidence — duplicating AC/evidence on the
    // payload is redundant and unsatisfiable through Claude Code's
    // TaskUpdate (which drops user-provided `metadata`).
    if (isa.kind === "sufficient") return SAFE_DEFAULT

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
    if (!hasAcSignal && !hasEvSignal && !insufficientIsa) return SAFE_DEFAULT

    return {
      decision: "block",
      reason:
        "Task completion requires acceptance_criteria and evidence fields. Provide both before marking complete.",
    } satisfies HookDecision
  })
