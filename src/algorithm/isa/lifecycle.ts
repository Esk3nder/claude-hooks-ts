/**
 * ISA lifecycle façade — pure planning and rendering helpers for the
 * UserPromptSubmit engagement directive, plus orchestration helpers for
 * the Stop and PostToolUse handlers.
 *
 * This module is the seam between classification (services/inference) and
 * the prompt-router handler: given a Classification, `planEngagement`
 * decides whether engagement is required and packages everything the
 * directive needs; `renderEngagementDirective` turns that plan into the
 * exact multi-line ENGAGE string the model sees.
 *
 * `checkStopReadiness` and `handlePostToolUseIsaEffects` migrated from
 * `events/stop-definition-of-done.ts` and `events/post-edit-quality.ts`
 * respectively (PR 1b). They preserve behavior exactly and exist so the
 * handlers stop re-implementing ISA orchestration inline.
 *
 * Behavior-preserving: the rendered string is byte-identical to the
 * previous in-handler composition in `events/prompt-router.ts`, and the
 * Stop/PostToolUse semantics match the prior in-handler logic byte-for-byte.
 */
import { Effect } from "effect"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import type { Classification, Tier } from "../../services/inference.ts"
import { safeResolvePath } from "../../services/path-resolution.ts"
import type { SessionStateRecord } from "../../services/session-state.ts"
import { runCheckpoint } from "./checkpoint.ts"
import { checkCompleteness } from "./completeness.ts"
import { countCriteria, parseCriteriaList } from "./criteria.ts"
import { parseFrontmatter } from "./frontmatter.ts"
import { findLatestISA, findProjectIsa } from "./locate.ts"
import {
  loadProbes,
  matchProbes,
  parseTestStrategy,
  probesPathFor,
  resolveProbe,
  runProbe,
} from "./probes.ts"
import { parseSections, type IsaSectionName } from "./sections.ts"
import {
  EFFORT_BY_TIER,
  REQUIRED_SECTIONS_BY_TIER,
  expectedIsaPathFor,
  shouldRequireEngagement,
} from "./tier-policy.ts"

export interface EngagementPlan {
  readonly tier: 3 | 4 | 5
  readonly isaPath: string
  readonly effort: string
  readonly sections: ReadonlyArray<IsaSectionName>
}

/**
 * Decide whether the classification demands an ISA engagement and, if so,
 * return everything the directive renderer needs. Returns `null` for
 * MINIMAL, NATIVE, or ALGORITHM tier < 3 — the caller treats `null` as
 * "no engagement directive line, engagement_required = false".
 */
export const planEngagement = (
  c: Classification,
  sessionId: string,
): EngagementPlan | null => {
  if (!shouldRequireEngagement(c)) return null
  const tier = c.tier
  return {
    tier,
    isaPath: expectedIsaPathFor(sessionId),
    effort: EFFORT_BY_TIER[tier],
    sections: REQUIRED_SECTIONS_BY_TIER[tier],
  }
}

/**
 * Render the multi-line ENGAGE directive shown to the model as the third
 * additionalContext line. The exact wording, punctuation, and newline
 * placement are part of the contract — downstream gates and operator
 * expectations key on it — so changes here are observable behavior.
 */
export const renderEngagementDirective = (plan: EngagementPlan): string => {
  const sections = plan.sections.join(", ")
  return (
    `ENGAGE: ALGORITHM_ENGAGEMENT_REQUIRED=true | TIER=E${plan.tier} | ` +
    `ISA_PATH=${plan.isaPath}\n` +
    `MANDATORY FIRST ACTION before any non-ISA implementation work: ` +
    `create or update the ISA at \`${plan.isaPath}\` (or, if a project ISA ` +
    `exists at \`<repo>/ISA.md\`, append to it). ` +
    `Minimum frontmatter: \`effort: ${plan.effort}\`, \`phase: observe\`. ` +
    `Required sections for E${plan.tier}: ${sections}. ` +
    `Do not mark \`phase: complete\` until each ISC under \`## Criteria\` ` +
    `has matching evidence under \`## Verification\`. ` +
    `The Stop gate now blocks once if this run ends without an ISA at the ` +
    `expected path; absence is treated as failure, not noop. Skipping ISA ` +
    `creation is a CRITICAL FAILURE.`
  )
}

// ──────────────────────────────────────────────────────────────────────
// Session-scoped ISA identity
// ──────────────────────────────────────────────────────────────────────

/**
 * Engagement-relevant slice of SessionStateRecord that resolveActiveIsa
 * consults. Kept minimal so callers don't need the full record type.
 */
export type ResolveActiveIsaRecord = Pick<
  SessionStateRecord,
  "engagement_required" | "expected_isa_path_absolute" | "expected_isa_path"
>

export interface ResolveActiveIsaInput {
  readonly sessionRoot: string
  readonly record: ResolveActiveIsaRecord
}

/**
 * Resolve the ISA that this session's engaged-mode gates should consult.
 *
 * Precedence:
 *   1. Project ISA at `<sessionRoot>/ISA.md` — explicit human-authored
 *      override always wins.
 *   2. The session's own `expected_isa_path_absolute` (or, if only the
 *      relative `expected_isa_path` is set, the resolved-from-sessionRoot
 *      form) IF that file exists on disk.
 *   3. `findLatestISA(sessionRoot)` — but only when `engagement_required`
 *      is FALSE. This preserves legacy behavior for non-engaged sessions
 *      while preventing a stale foreign-slug ISA from satisfying an
 *      engaged session's gates.
 *
 * Returns null when no candidate exists on disk.
 */
export const resolveActiveIsa = (input: ResolveActiveIsaInput): string | null => {
  const { sessionRoot, record } = input
  const projectIsa = findProjectIsa(sessionRoot)
  if (projectIsa !== null && existsSync(projectIsa)) return projectIsa

  const expected =
    record.expected_isa_path_absolute ??
    (record.expected_isa_path === null
      ? null
      : safeResolvePath(sessionRoot, record.expected_isa_path))
  if (expected !== null && existsSync(expected)) return expected

  if (!record.engagement_required) {
    const latest = findLatestISA(sessionRoot)
    return latest !== null && existsSync(latest) ? latest : null
  }
  return null
}

// ──────────────────────────────────────────────────────────────────────
// Stop readiness verdict
// ──────────────────────────────────────────────────────────────────────

/**
 * Map ISA frontmatter `effort` field to numeric tier (IsaFormat.md:72).
 * Returns null when effort is missing or unrecognized — caller treats null
 * as "no tier-based gating possible" and skips the check.
 */
const tierFromEffort = (effort: string | undefined): Tier | null => {
  switch (effort) {
    case "standard":
      return 1
    case "extended":
      return 2
    case "advanced":
      return 3
    case "deep":
      return 4
    case "comprehensive":
      return 5
    default:
      return null
  }
}

/**
 * Map ISA frontmatter `tier` field to numeric tier. Accepts `E1`–`E5`
 * (canonical short form per IsaFormat.md) or bare `1`–`5`. Returns null
 * for missing / unrecognized values.
 *
 * Pre-existing `tierFromEffort` reads only the legacy `effort:` field
 * (`standard` / `extended` / etc.). Canonical ISAs use `tier: E3`, so
 * relying on `effort` alone made the Tier Completeness Gate dead code
 * for the documented format. Caller now consults both via `parseTier`.
 */
const tierFromTier = (tier: string | undefined): Tier | null => {
  if (typeof tier !== "string") return null
  const m = tier.trim().match(/^[Ee]?([1-5])$/)
  if (m === null || m[1] === undefined) return null
  const n = Number(m[1]) as 1 | 2 | 3 | 4 | 5
  return n
}

/**
 * Resolve tier from frontmatter, preferring the canonical `tier:` field
 * over the legacy `effort:` field. If both are present and disagree,
 * prefer `tier:` (canonical) — the legacy field is best-effort
 * back-compat, not authoritative.
 */
const parseTier = (fm: Record<string, string>): Tier | null => {
  return tierFromTier(fm["tier"]) ?? tierFromEffort(fm["effort"])
}

/**
 * The verdict from `checkStopReadiness`. Expressive enough to preserve the
 * prior in-handler behavior:
 *   - `block`: a doctrinal violation was detected — Stop should block once
 *     with the embedded reason.
 *   - `noop`: nothing about the ISA should stop this Stop; caller proceeds
 *     to its other gates.
 */
export type StopReadinessVerdict =
  | { readonly _tag: "block"; readonly reason: string }
  | { readonly _tag: "noop" }

export interface StopReadinessInput {
  readonly cwd: string
  // When present, resolveActiveIsa scopes the ISA lookup to the session's
  // expected ISA (rather than findLatestISA under cwd). Legacy callers may
  // omit this; in that case the previous projectIsa-or-latestIsa lookup is
  // preserved so non-engaged sessions stay correct.
  readonly record?: ResolveActiveIsaRecord
}

/**
 * Compute whether the active ISA blocks Stop. Returns a `block` verdict with
 * a model-actionable reason, or a `noop` when nothing about the ISA should
 * stop this Stop.
 *
 * Two block conditions, both per Algorithm v6.3.0 + IsaFormat.md doctrine:
 *   1. ISA frontmatter says `phase: complete` but the Tier Completeness Gate
 *      (IsaFormat.md:191-201) shows missing required sections.
 *   2. ISA frontmatter says `phase: complete` but `progress` shows unchecked
 *      ISCs (i.e., not all criteria passed).
 *
 * Path adaptation: project-ISA detection uses `cwd`. The check is skipped
 * entirely when no ISA is found — Stop proceeds normally.
 */
export const checkStopReadiness = (
  input: StopReadinessInput,
): StopReadinessVerdict => {
  const { cwd, record } = input
  const projectIsa = findProjectIsa(cwd)
  // When a session record is threaded through, scope the lookup to the
  // session's own ISA so a stale foreign-slug ISA can't satisfy gates.
  // Legacy callers (no record) keep the original projectIsa-or-latestIsa
  // fallback so non-engaged paths stay correct.
  const isaPath =
    record !== undefined
      ? resolveActiveIsa({ sessionRoot: cwd, record })
      : (projectIsa ?? findLatestISA(cwd))
  if (isaPath === null) return { _tag: "noop" }
  if (!existsSync(isaPath)) return { _tag: "noop" }

  let content: string
  try {
    content = readFileSync(isaPath, "utf-8")
  } catch {
    return { _tag: "noop" }
  }
  const fm = parseFrontmatter(content)
  if (fm === null) return { _tag: "noop" }

  const phase = (fm["phase"] ?? "").toLowerCase().trim()
  if (phase !== "complete") return { _tag: "noop" }

  // Phase claims complete — apply both gates.
  const tier = parseTier(fm)
  const isProjectIsa = projectIsa !== null
  if (tier !== null) {
    const report = checkCompleteness(content, tier, { isProjectIsa })
    if (!report.ok) {
      return {
        _tag: "block",
        reason:
          `ISA at ${isaPath} declares phase: complete but the Tier ` +
          `Completeness Gate (IsaFormat.md:191-201) reports missing ` +
          `sections for tier E${report.tier}: ${report.missing.join(", ")}. ` +
          `Add the required sections OR roll the phase back to a non-complete ` +
          `state before declaring done.`,
      }
    }
  }

  const counts = countCriteria(content)
  if (counts.total > 0 && counts.checked < counts.total) {
    return {
      _tag: "block",
      reason:
        `ISA at ${isaPath} declares phase: complete but ` +
        `${counts.total - counts.checked} of ${counts.total} ISC criteria ` +
        `are still unchecked. Verify the remaining ISCs and flip them to ` +
        `[x], OR roll the phase back to a non-complete state.`,
    }
  }

  return { _tag: "noop" }
}

// ──────────────────────────────────────────────────────────────────────
// PostToolUse probe → flip → checkpoint orchestration
// ──────────────────────────────────────────────────────────────────────

/**
 * Flip an ISC's `[ ]` checkbox to `[x]` in-place. Returns true on success
 * (a flip was actually performed), false if the line was already checked
 * or the criterion line wasn't found. Idempotent.
 *
 * Used by the probe-runner branch — when a probe passes for a pending ISC,
 * we edit the ISA so checkpoint.ts can pick up the transition on the next
 * PostToolUse event.
 */
const flipIscCheckbox = (isaPath: string, iscId: string): boolean => {
  if (!existsSync(isaPath)) return false
  let content: string
  try {
    content = readFileSync(isaPath, "utf-8")
  } catch {
    return false
  }
  // Match a `- [ ]` line whose ID is exactly `iscId`. Word-boundary on the
  // ID prevents `ISC-1` from matching `ISC-1.2` or `ISC-12`.
  const escaped = iscId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(`^(- \\[) (\\]\\s*${escaped}\\b)`, "m")
  if (!re.test(content)) return false
  const next = content.replace(re, "$1x$2")
  if (next === content) return false
  try {
    writeFileSync(isaPath, next, "utf-8")
    return true
  } catch (err) {
    process.stderr.write(`[probes] failed to flip ${iscId}: ${String(err)}\n`)
    return false
  }
}

/**
 * Run probes against the latest ISA: parse criteria + Test Strategy,
 * resolve declared probes against the registry, execute each, flip
 * checkboxes for passes, and — atomically with the flip — run
 * `runCheckpoint` so the transitions actually commit.
 *
 * F3 historical bug: probe-flipped ISCs were dead-letters because the
 * hook-side `writeFileSync` does NOT fire PostToolUse (only model tool
 * calls do), so checkpoint never saw the transition. The fix was to call
 * `runCheckpoint` explicitly after any flip. This façade preserves that
 * coupling — flip and checkpoint are a single atomic unit — to prevent
 * the F3-style flip-without-commit class of bug from reappearing.
 *
 * Non-blocking: errors are logged to stderr; the returned Effect never
 * fails (defects are caught and swallowed at the boundary).
 *
 * No-ops when:
 *   - no `probes.ts` exists at the project root
 *   - no ISA is locatable
 *   - the ISA has no criteria, no Test Strategy section, or an empty
 *     strategy map
 *   - the registry is empty
 */
/**
 * Run the post-edit ISA effects sequence rooted at `cwd`.
 *
 * `cwd` should be the session's frozen `session_root` (from SessionState).
 * Defaulting to `process.cwd()` keeps non-engagement sessions and other
 * out-of-band callers unchanged. After engagement, the caller threads the
 * frozen root so a Bash `cd` does not move the probe runner's view of the
 * active ISA.
 */
export const handlePostToolUseIsaEffects = (
  cwd: string = process.cwd(),
  record?: ResolveActiveIsaRecord,
): Effect.Effect<void, never> =>
  Effect.tryPromise({
    try: async () => {
      if (!existsSync(probesPathFor(cwd))) return
      // When a session record is provided, scope the probe target to the
      // session's own ISA via resolveActiveIsa — a stale foreign-slug ISA
      // under the root must NOT be flipped by the current session.
      // Legacy callers (no record) keep the original latest-or-project
      // fallback for backwards compatibility with non-engaged sessions.
      // `cwd` is the frozen `session_root` passed by the PostToolUse
      // handler so a Bash `cd` after engagement does not move the probe
      // runner's view of the active ISA.
      const isa =
        record !== undefined
          ? resolveActiveIsa({ sessionRoot: cwd, record })
          : (findLatestISA(cwd) ?? findProjectIsa(cwd))
      if (isa === null) return
      if (!existsSync(isa)) return
      const content = readFileSync(isa, "utf-8")
      const criteria = parseCriteriaList(content)
      if (criteria.length === 0) return
      const sections = parseSections(content)
      const tsBody = sections.get("Test Strategy")?.body ?? ""
      if (tsBody.length === 0) return
      const strategyMap = parseTestStrategy(tsBody)
      if (strategyMap.size === 0) return
      const registry = await loadProbes(cwd)
      if (Object.keys(registry).length === 0) return
      const matches = matchProbes(criteria, strategyMap, registry, (miss) => {
        const known =
          miss.registeredNames.length === 0
            ? "registry is empty"
            : `registry has [${miss.registeredNames.join(", ")}]`
        process.stderr.write(
          `[probes] ${miss.iscId} declares probe '${miss.probeName}' but ${known} — check that probes.ts exports a key matching the ISA's 'tool' column\n`,
        )
      })
      let anyFlipped = false
      for (const m of matches) {
        const { fn, timeoutMs } = resolveProbe(m.probe)
        const passed = await Effect.runPromise(
          runProbe(fn, m.criterion, timeoutMs),
        )
        if (passed && flipIscCheckbox(isa, m.criterion.id)) {
          anyFlipped = true
        }
      }
      // Atomic with the flip: if anything flipped, checkpoint MUST run so
      // the ISC transitions land in a commit. Do NOT split these — that
      // is the F3-style bug class this façade exists to prevent.
      if (anyFlipped) {
        try {
          await runCheckpoint(isa, cwd)
        } catch (err) {
          process.stderr.write(
            `[probes] post-flip checkpoint failed: ${String(err)}\n`,
          )
        }
      }
    },
    catch: (cause) => {
      process.stderr.write(`[probes] uncaught: ${String(cause)}\n`)
      return new Error(String(cause))
    },
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
