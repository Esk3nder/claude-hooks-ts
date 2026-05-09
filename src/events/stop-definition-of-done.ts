import { Effect } from "effect"
import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { promisify } from "node:util"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { SessionState } from "../services/session-state.ts"
import { findLatestISA, findProjectIsa } from "../algorithm/isa/locate.ts"
import { parseFrontmatter } from "../algorithm/isa/frontmatter.ts"
import { countCriteria } from "../algorithm/isa/criteria.ts"
import { checkCompleteness } from "../algorithm/isa/completeness.ts"
import type { Tier } from "../services/inference.ts"
import { loadRegenerateRules, matchRules } from "../policies/regenerate.ts"

const execFileAsync = promisify(execFile)
const REGEN_TIMEOUT_MS = 10_000

const BLOCK_REASON =
  "Code changed but no verification command has run. Run the smallest relevant test/typecheck now, then summarize the result."

const RESEARCH_BLOCK_REASON =
  "Research answer is not ready: source ledger has unsupported claims. Reconcile claims to sources and state uncertainties before final response."

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

interface IsaGateBlock {
  readonly _tag: "block"
  readonly reason: string
}
interface IsaGateNoop {
  readonly _tag: "noop"
}

/**
 * Compute whether the active ISA blocks Stop. Returns a "block" verdict with
 * a model-actionable reason, or a "noop" when nothing about the ISA should
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
const checkIsaGate = (cwd: string): IsaGateBlock | IsaGateNoop => {
  const projectIsa = findProjectIsa(cwd)
  const taskIsa = findLatestISA(cwd)
  const isaPath = projectIsa ?? taskIsa
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
  const tier = tierFromEffort(fm["effort"])
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

/**
 * Stop handler.
 *
 * Loop-protection note: the official Claude Code Stop event payload does NOT
 * carry a `stop_hook_active` field (despite earlier docs/community examples).
 * We instead rely on `SessionState.stop_blocked_once` — once a session has
 * blocked one Stop, the next Stop in that session is allowed through to
 * avoid an infinite block loop.
 */
export const handleStop = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, SessionState> =>
  Effect.gen(function* () {
    if (payload._tag !== "Stop") return SAFE_DEFAULT
    const state = yield* SessionState
    const record = yield* state
      .get(payload.session_id)
      .pipe(Effect.catchAll(() => Effect.succeed(null)))
    if (record === null) return SAFE_DEFAULT
    // Local loop-guard: never block twice in the same session.
    if (record.stop_blocked_once) return SAFE_DEFAULT

    // ISA completeness gate — runs first because an ISA declaring
    // phase: complete with missing sections / unchecked ISCs is a
    // doctrine violation no other gate catches. IsaFormat.md:191-201.
    const cwd =
      typeof payload.cwd === "string" && payload.cwd.length > 0
        ? payload.cwd
        : process.cwd()
    const isaVerdict = checkIsaGate(cwd)
    if (isaVerdict._tag === "block") {
      yield* state
        .update(payload.session_id, { stop_blocked_once: true })
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      const out: HookDecision = {
        decision: "block",
        reason: isaVerdict.reason,
      }
      return out
    }

    // Research-mode source-ledger gate
    const lw = record.last_workflow
    if (
      typeof lw === "string" &&
      lw.startsWith("research.") &&
      record.source_urls.length === 0
    ) {
      yield* state
        .update(payload.session_id, { stop_blocked_once: true })
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      const out: HookDecision = {
        decision: "block",
        reason: RESEARCH_BLOCK_REASON,
      }
      return out
    }

    const filesChanged = record.files_changed.length
    if (filesChanged > 0 && record.verification_status !== "passed") {
      yield* state
        .update(payload.session_id, { stop_blocked_once: true })
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      const out: HookDecision = {
        decision: "block",
        reason: BLOCK_REASON,
      }
      return out
    }

    // 4b doc-integrity regen: best-effort run of declarative regenerate.yaml
    // rules whose `source` glob matched any file changed this session. Runs
    // AFTER all blocking gates pass so we don't waste regen work on a
    // session that's about to be blocked. Failures are logged, never block.
    const rules = loadRegenerateRules(cwd)
    if (rules.length > 0 && record.files_changed.length > 0) {
      const matched = matchRules(record.files_changed, rules)
      for (const rule of matched) {
        // F6: log what we're about to run BEFORE exec so users have a paper
        // trail of what their regenerate.yaml is doing on their behalf.
        // Truncate the command preview at 160 chars to keep the line scannable.
        const cmdPreview = Array.isArray(rule.command)
          ? rule.command.join(" ")
          : rule.command
        process.stderr.write(
          `[regenerate] running for ${rule.derived}: ${cmdPreview.slice(0, 160)}${cmdPreview.length > 160 ? "..." : ""}\n`,
        )
        yield* Effect.tryPromise({
          try: async () => {
            const args = Array.isArray(rule.command)
              ? { cmd: rule.command[0] ?? "", argv: rule.command.slice(1) }
              : { cmd: "sh", argv: ["-c", rule.command as string] }
            if (args.cmd.length === 0) return
            await execFileAsync(args.cmd, args.argv as string[], {
              cwd,
              timeout: REGEN_TIMEOUT_MS,
            })
          },
          catch: (cause) => {
            process.stderr.write(
              `[regenerate] ${rule.derived} failed: ${String(cause).slice(0, 200)}\n`,
            )
            return new Error(String(cause))
          },
        }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      }
    }

    return SAFE_DEFAULT
  })
