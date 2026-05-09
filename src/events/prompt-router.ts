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
import type { Inference } from "../services/inference.ts"
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
 */
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

 // Step 3 — transcript context. Effectful because it
 // reads from disk; isolated to a sync helper so failure is silent.
 const context = getRecentContext(payload.transcript_path)

 // Step 4 — mode classifier with context.
 const classification = yield* classify(payload.prompt, { context })
 const modeLine = renderClassificationLine(classification)
 const workflowLine = `Detected workflow: ${workflow}. ${playbook}`
 const additionalContext = `${workflowLine}\n${modeLine}`

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
