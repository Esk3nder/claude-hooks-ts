import { Effect } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { NO_DECISION } from "../schema/decisions.ts"
import {
  classifyPrompt,
  requiresWebSources,
} from "../policies/workflow-classifier.ts"
import { SessionState } from "../services/session-state.ts"
import {
  classify,
  renderClassificationLine,
  isSystemTextPrompt,
} from "../algorithm/classifier.ts"
import { getRecentContext } from "../algorithm/transcript-context.ts"
import type { Inference } from "../services/inference.ts"
import type { ClaudeSubprocess } from "../services/claude-subprocess.ts"
import type { CommandRunner } from "../services/command-runner.ts"
import {
  ClassifierTelemetry,
  buildRecord,
} from "../services/classifier-telemetry.ts"
import {
  planEngagement,
  renderEngagementDirective,
  resolveActiveIsa,
} from "../algorithm/isa/lifecycle.ts"
import { resolveExpectedIsaAbsolute } from "../algorithm/isa/path-contract.ts"
import { detectSessionRoot } from "../services/project-root.ts"
import { safeResolvePath } from "../services/path-resolution.ts"
import { reportHookFailure } from "../services/hook-failure.ts"

const UNKNOWN_MULTI_FILE_CUES =
  /\b(multi[- ]file|across files|whole repo|entire repo|codebase-wide|several files|many files|map relationships|trace|investigat(?:e|ion)|audit)\b/i

const shouldPreferAgentDelegation = (
  workflow: string,
  prompt: string,
): boolean =>
  workflow === "research.repo" ||
  workflow === "research.synthesis" ||
  (workflow === "unknown" && UNKNOWN_MULTI_FILE_CUES.test(prompt))

/**
 * UserPromptSubmit handler — TWO classifiers, layered (B4) — with the full
 * this package feature set: transcript context, telemetry, prompt sanitization,
 * system-text short-circuit.
 *
 * Order of operations (implements canonical behavior PromptProcessing.hook.ts main flow):
 *
 * 1. System-text short-circuit. If the prompt is a
 * `<system-reminder>`, `<task-notification>`, or other system-injected
 * string, emit NO additionalContext, no telemetry — just NO_DECISION.
 * this package does this with `process.exit(0)`; we return.
 *
 * 2. Regex `workflow-classifier` (cheap, sync). Owns `last_workflow` in
 * SessionState — the research-mode Stop gate reads it. Emits
 * "Detected workflow: X. <playbook>" as the FIRST additionalContext line.
 *
 * 3. Read transcript context. Last 6 turns including
 * assistant. This is what makes the "single-word approval" doctrine
 * rule fireable — Sonnet needs prior turns to disambiguate.
 *
 * 4. Mode classifier (`algorithm/classifier.ts`). Tries deterministic
 * fast-path; falls back to Sonnet via the B2 chokepoint with
 * cleanPrompt + CONTEXT/CURRENT MESSAGE framing. Emits the canonical
 * "MODE: ... | TIER: ... | REASON: ... | SOURCE: ..." as the SECOND line.
 *
 * 5. Telemetry (the classifier, 875-879, 1018-1024). Append the
 * classification record to mode-classifier.jsonl for weekly audit:
 * classifier-vs-fail-safe ratio, average latency, downstream override
 * rate.
 *
 * 6. Engagement directive. When the classification is ALGORITHM tier ≥ 3,
 * append a third additionalContext line that names the next concrete
 * action (scaffold an ISA). Without this line the downstream
 * stop-definition-of-done / task-integrity / post-edit-quality /
 * checkpoint gates noop on absence — they only verify an ISA that
 * exists. Two informative lines are not enough to trigger the reflex;
 * an imperative naming the artifact path is.
 */
export const handleUserPromptSubmit = (
  payload: HookPayload,
): Effect.Effect<
  HookDecision,
  never,
  SessionState | Inference | ClaudeSubprocess | ClassifierTelemetry | CommandRunner
> =>
  Effect.gen(function* () {
    if (payload._tag !== "UserPromptSubmit") return NO_DECISION

    // Step 1 — system-text short-circuit.
    if (isSystemTextPrompt(payload.prompt)) {
      return NO_DECISION
    }

    // Step 2 — regex workflow tagger. Two outputs:
    //  - `workflow` (loose, drives the priming playbook line)
    //  - `requires_web_sources` (strict, drives the Stop research-mode
    //    source-ledger gate). Kept separate so a loose priming match
    //    cannot turn into a source-URL requirement at Stop time.
    const { workflow, playbook } = classifyPrompt(payload.prompt)
    // US-4: pass the workflow tag as a scoping signal. `coding.*` /
    // `writing.*` / `ops.*` short-circuit to false, eliminating false-
    // positive Stop-loops on coding tasks that mention "current best
    // practices" or similar phrases. `research.*` always returns true.
    // `unknown` falls through to the existing strict-pattern match.
    const requiresWebSrc = requiresWebSources(payload.prompt, workflow)
    const state = yield* SessionState
    const sessionId = payload.session_id
    const existing = yield* state
      .get(sessionId)
      .pipe(
        Effect.catchAll((cause) =>
          reportHookFailure({
            kind: "state_read_failed",
            event: "UserPromptSubmit",
            sessionId,
            cause,
            hookSafe: true,
            context: { op: "existing-read", cwd: payload.cwd },
          }).pipe(Effect.as(null)),
        ),
      )
    const existingSourceObligationActive =
      existing?.requires_web_sources === true && existing.source_urls.length === 0
    const nextRequiresWebSources =
      requiresWebSrc || existingSourceObligationActive
    // Enforcement-plane P1 #7: when the new prompt requires web sources,
    // reset `source_ledger_opt_out` to false. Pre-fix, an earlier ISA
    // declaring `source_ledger: not_applicable` would leave the flag
    // sticky-true; a subsequent web-source-requiring task would then
    // bypass the Stop source-ledger gate. The opt-out is meant to be
    // per-ISA, so a new source-requiring prompt resets the slate.
    const workflowPatch = {
      last_workflow: workflow,
      requires_web_sources: nextRequiresWebSources,
      ...(requiresWebSrc
        ? { source_urls: [], source_ledger_opt_out: false }
        : {}),
    }
    yield* state
      .update(sessionId, workflowPatch)
      .pipe(
        Effect.catchAll((cause) =>
          reportHookFailure({
            kind: "state_write_failed",
            event: "UserPromptSubmit",
            sessionId,
            cause,
            hookSafe: true,
            context: { op: "workflow-update", cwd: payload.cwd },
          }),
        ),
      )

    // Step 3 — transcript context. Effectful because it
    // reads from disk; isolated to a sync helper so failure is silent.
    const context = getRecentContext(payload.transcript_path)

    // Step 4 — mode classifier with context.
    const classification = yield* classify(payload.prompt, { context })
    const modeLine = renderClassificationLine(classification)
    const delegationNudge = shouldPreferAgentDelegation(workflow, payload.prompt)
      ? " Prefer Agent delegation for this turn."
      : ""
    const workflowLine = `Detected workflow: ${workflow}. ${playbook}${delegationNudge}`
    const plan = planEngagement(classification, sessionId)

    // Step 4b — engagement bookkeeping. Stop / PostToolUse gates read
    // these fields; without them they cannot tell "no ISA" (legitimate
    // for a one-off NATIVE prompt) from "no ISA after ALGORITHM E3+ was
    // demanded" (a doctrine violation).
    //
    // ISA identity is a session invariant. We freeze `session_root` and
    // `expected_isa_path_absolute` write-once for the lifetime of a
    // session: if a prior ALGORITHM prompt already froze them, subsequent
    // prompts MUST NOT overwrite (even if `payload.cwd` has drifted since
    // — e.g. after a Bash `cd ~/.claude/skills/...`). The relative
    // `expected_isa_path` stays for display and back-compat; downstream
    // gates prefer `expected_isa_path_absolute`.
    const engagementRequired = plan !== null
    const initialCwd =
      typeof payload.cwd === "string" && payload.cwd.length > 0
        ? payload.cwd
        : process.cwd()
    const existingEngagementActive = existing?.engagement_required === true
    const sessionRoot = engagementRequired
      ? (existing?.session_root ?? (yield* detectSessionRoot(initialCwd)))
      : existingEngagementActive
        ? (existing?.session_root ?? null)
      : null
    const existingExpectedAbsolute =
      existingEngagementActive && sessionRoot !== null && existing !== null
        ? resolveExpectedIsaAbsolute(sessionRoot, existing)
        : null
    const expectedIsaPathAbsolute =
      engagementRequired && sessionRoot !== null && plan !== null
        ? (existingExpectedAbsolute ?? safeResolvePath(sessionRoot, plan.isaPath))
        : existingEngagementActive
          ? existingExpectedAbsolute
        : null
    const activeIsaPath =
      engagementRequired && sessionRoot !== null && plan !== null
        ? resolveActiveIsa({
            sessionRoot,
            record: {
              engagement_required: true,
              expected_isa_path: plan.isaPath,
              expected_isa_path_absolute: expectedIsaPathAbsolute,
              last_mode: classification.mode,
              last_tier: classification.tier,
            },
          })
        : null
    const engageLine =
      plan === null ? null : renderEngagementDirective(plan, { activeIsaPath })
    // D3: surface regenerate.yaml rules that the prior Stop skipped due to
    // wall-clock budget. One-shot — cleared in the same state.update below.
    const regenSkipped = existing?.regenerate_skipped ?? []
    const regenSkippedLine =
      regenSkipped.length > 0
        ? `Note: previous Stop skipped regenerate rule(s) due to time budget: ${regenSkipped.join(", ")}. Re-run them manually if their derived artifacts are stale.`
        : null
    const baseContext = engageLine
      ? `${workflowLine}\n${modeLine}\n${engageLine}`
      : `${workflowLine}\n${modeLine}`
    const additionalContext = regenSkippedLine
      ? `${baseContext}\n${regenSkippedLine}`
      : baseContext
    const nextEngagementRequired = engagementRequired || existingEngagementActive
    yield* state
      .update(sessionId, {
        last_mode: engagementRequired
          ? classification.mode
          : existingEngagementActive
            ? (existing?.last_mode ?? classification.mode)
            : classification.mode,
        last_tier: engagementRequired
          ? classification.tier
          : existingEngagementActive
            ? (existing?.last_tier ?? classification.tier)
            : classification.tier,
        engagement_required: nextEngagementRequired,
        expected_isa_path: engagementRequired
          ? plan.isaPath
          : existingEngagementActive
            ? (existing?.expected_isa_path ?? null)
            : null,
        session_root: sessionRoot,
        expected_isa_path_absolute: expectedIsaPathAbsolute,
        // D3: clear the one-shot regenerate-skipped marker once surfaced.
        ...(regenSkipped.length > 0 ? { regenerate_skipped: [] } : {}),
      })
      .pipe(
        Effect.catchAll((cause) =>
          reportHookFailure({
            kind: "state_write_failed",
            event: "UserPromptSubmit",
            sessionId,
            cause,
            hookSafe: true,
            context: { op: "engagement-update", cwd: payload.cwd },
          }),
        ),
      )

    // Step 5 — telemetry (best-effort, never blocks).
    const telemetry = yield* ClassifierTelemetry
    yield* telemetry.append(
      buildRecord({
        sessionId: payload.session_id,
        prompt: payload.prompt,
        mode: classification.mode,
        tier: classification.tier,
        modeReason: classification.reason,
        source: classification.source,
        latencyMs: classification.latencyMs,
      }),
    )

    const out: HookDecision = {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
    }
    return out
  })
