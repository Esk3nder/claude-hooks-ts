import { Effect } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { classifyPrompt } from "../policies/workflow-classifier.ts"
import { SessionState } from "../services/session-state.ts"
import {
  classify,
  renderClassificationLine,
  isSystemTextPrompt,
} from "../algorithm/classifier.ts"
import { getRecentContext } from "../algorithm/transcript-context.ts"
import type { Classification, Inference } from "../services/inference.ts"
import type { ClaudeSubprocess } from "../services/claude-subprocess.ts"
import {
  ClassifierTelemetry,
  buildRecord,
} from "../services/classifier-telemetry.ts"

/**
 * UserPromptSubmit handler — TWO classifiers, layered (B4) — with the full
 * this package feature set: transcript context, telemetry, prompt sanitization,
 * system-text short-circuit.
 *
 * Order of operations (implements canonical behavior PromptProcessing.hook.ts main flow):
 *
 * 1. System-text short-circuit. If the prompt is a
 * `<system-reminder>`, `<task-notification>`, or other system-injected
 * string, emit NO additionalContext, no telemetry — just SAFE_DEFAULT.
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
/**
 * Required ISA sections per tier — mirrors IsaFormat.md tier completeness
 * gate (E3 = 8 sections, E4/E5 = all 12). E1 and E2 are not engagement
 * targets here (the gate fires only at tier ≥ 3).
 */
const REQUIRED_SECTIONS_BY_TIER: Record<3 | 4 | 5, ReadonlyArray<string>> = {
  3: [
    "Problem",
    "Vision",
    "Out of Scope",
    "Constraints",
    "Goal",
    "Criteria",
    "Features",
    "Test Strategy",
  ],
  4: [
    "Problem",
    "Vision",
    "Out of Scope",
    "Principles",
    "Constraints",
    "Goal",
    "Criteria",
    "Test Strategy",
    "Features",
    "Decisions",
    "Changelog",
    "Verification",
  ],
  5: [
    "Problem",
    "Vision",
    "Out of Scope",
    "Principles",
    "Constraints",
    "Goal",
    "Criteria",
    "Test Strategy",
    "Features",
    "Decisions",
    "Changelog",
    "Verification",
  ],
}

const EFFORT_BY_TIER: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "standard",
  2: "extended",
  3: "advanced",
  4: "deep",
  5: "comprehensive",
}

/**
 * Compute the deterministic ISA path for a session. The slug is the raw
 * session_id so the path is reproducible from the payload alone — no model
 * guessing, no late binding. Stop / PostToolUse gates use the same field
 * (SessionState.expected_isa_path) so directive text and gate behavior agree.
 */
export const expectedIsaPathFor = (sessionId: string): string =>
  `.claude-hooks/work/${sessionId}/ISA.md`

const engageDirectiveFor = (
  c: Classification,
  sessionId: string,
): string | null => {
  if (c.mode !== "ALGORITHM" || c.tier === null || c.tier < 3) return null
  const tier = c.tier as 3 | 4 | 5
  const sections = REQUIRED_SECTIONS_BY_TIER[tier].join(", ")
  const isaPath = expectedIsaPathFor(sessionId)
  const effort = EFFORT_BY_TIER[tier]
  return (
    `ENGAGE: ALGORITHM_ENGAGEMENT_REQUIRED=true | TIER=E${tier} | ` +
    `ISA_PATH=${isaPath}\n` +
    `MANDATORY FIRST ACTION before any non-ISA implementation work: ` +
    `create or update the ISA at \`${isaPath}\` (or, if a project ISA ` +
    `exists at \`<repo>/ISA.md\`, append to it). ` +
    `Minimum frontmatter: \`effort: ${effort}\`, \`phase: observe\`. ` +
    `Required sections for E${tier}: ${sections}. ` +
    `Do not mark \`phase: complete\` until each ISC under \`## Criteria\` ` +
    `has matching evidence under \`## Verification\`. ` +
    `The Stop gate now blocks once if this run ends without an ISA at the ` +
    `expected path; absence is treated as failure, not noop. Skipping ISA ` +
    `creation is a CRITICAL FAILURE.`
  )
}

export const handleUserPromptSubmit = (
  payload: HookPayload,
): Effect.Effect<
  HookDecision,
  never,
  SessionState | Inference | ClaudeSubprocess | ClassifierTelemetry
> =>
  Effect.gen(function* () {
    if (payload._tag !== "UserPromptSubmit") return SAFE_DEFAULT

    // Step 1 — system-text short-circuit.
    if (isSystemTextPrompt(payload.prompt)) {
      return SAFE_DEFAULT
    }

    // Step 2 — regex workflow tagger.
    const { workflow, playbook } = classifyPrompt(payload.prompt)
    const state = yield* SessionState
    yield* state
      .update(payload.session_id, { last_workflow: workflow })
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
    const sessionId = payload.session_id

    // Step 3 — transcript context. Effectful because it
    // reads from disk; isolated to a sync helper so failure is silent.
    const context = getRecentContext(payload.transcript_path)

    // Step 4 — mode classifier with context.
    const classification = yield* classify(payload.prompt, { context })
    const modeLine = renderClassificationLine(classification)
    const workflowLine = `Detected workflow: ${workflow}. ${playbook}`
    const engageLine = engageDirectiveFor(classification, sessionId)
    const additionalContext = engageLine
      ? `${workflowLine}\n${modeLine}\n${engageLine}`
      : `${workflowLine}\n${modeLine}`

    // Step 4b — engagement bookkeeping. Stop / PostToolUse gates read
    // these fields; without them they cannot tell "no ISA" (legitimate
    // for a one-off NATIVE prompt) from "no ISA after ALGORITHM E3+ was
    // demanded" (a doctrine violation).
    const engagementRequired = engageLine !== null
    yield* state
      .update(sessionId, {
        last_mode: classification.mode,
        last_tier: classification.tier,
        engagement_required: engagementRequired,
        expected_isa_path: engagementRequired
          ? expectedIsaPathFor(sessionId)
          : null,
      })
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)))

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
