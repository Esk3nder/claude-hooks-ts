/**
 * Two-step prompt classifier with deterministic fast-path gates.
 *
 * Step 1 — fast-path gates (skip the Sonnet subprocess entirely):
 * (a) `isExplicitRating` — numeric rating like "8" or "10/10" with
 * sentence-starter exclusions (so "8 things to fix" doesn't match).
 * (b) Positive praise — `POSITIVE_PRAISE_WORDS` (19) and
 * `POSITIVE_PHRASES` (12). Two-word praise composition allowed.
 * (c) System text — `SYSTEM_TEXT_PATTERNS`: `<task-notification>`,
 * `<system-reminder>`, "session is being continued", "Please continue",
 * "Note:.*was read before". These are system-injected, not user prompts.
 * (d) Short prompt — length < `MIN_PROMPT_LENGTH` (3) → MINIMAL.
 *
 * What is NOT a fast-path:
 * - Single-token "ok" / "yes" / "no" with non-trivial context → goes to
 * inference. The classifier rubric requires that single-word approvals
 * to multi-step plans inherit the proposal's mode and tier rather than
 * collapsing to MINIMAL, and only the Sonnet classifier sees the
 * conversation context needed to disambiguate.
 * - `/e1`-`/e5` overrides — these are EXECUTOR-side per Algorithm v6.3.0
 * line 92-94 ("Override hierarchy (executor side): 1. Explicit /e1-/e5
 * in the prompt forces tier"). The classifier emits its honest read; the
 * executor (model) applies the override on top.
 *
 * Step 2 — Inference. For everything else, delegate to the Inference service
 * (Sonnet via `claude --print`). On any failure that path returns FAIL_SAFE
 * (ALGORITHM tier 3) — under-escalation is the failure mode the Algorithm
 * was built to prevent.
 *
 * The function NEVER fails — callers can `yield*` it without catching.
 */

import { Effect } from "effect"
import {
 Inference,
 type Classification,
 type Tier,
} from "../services/inference.ts"
import type { ClaudeSubprocess } from "../services/claude-subprocess.ts"

// ════════════════════════════════════════════════════════════════
// FROM this hooks/PromptProcessing.hook.ts
// ════════════════════════════════════════════════════════════════

/** the classifier. */
const MIN_PROMPT_LENGTH = 3

/** the classifier. */
const POSITIVE_PRAISE_WORDS: ReadonlySet<string> = new Set([
 "excellent", "amazing", "brilliant", "fantastic", "wonderful", "beautiful",
 "incredible", "awesome", "perfect", "great", "nice", "superb", "outstanding",
 "magnificent", "stellar", "phenomenal", "remarkable", "terrific", "splendid",
])

/** the classifier. */
const POSITIVE_PHRASES: ReadonlySet<string> = new Set([
 "great job", "good job", "nice work", "well done", "nice job", "good work",
 "love it", "nailed it", "looks great", "looks good", "thats great", "that works",
])

/** the classifier. */
const SYSTEM_TEXT_PATTERNS: ReadonlyArray<RegExp> = [
 /^<task-notification>/i,
 /^<system-reminder>/i,
 /^This session is being continued from a previous conversation/i,
 /^Please continue the conversation/i,
 /^Note:.*was read before/i,
]

/** the classifier — . */
const isExplicitRating = (prompt: string): boolean => {
 const trimmed = prompt.trim()
 const match = trimmed.match(/^(10|[1-9])(?:\s*[-:]\s*|\s+)?(.*)$/)
 if (!match || match[1] === undefined) return false
 const afterNumber = trimmed.slice(match[1].length)
 if (afterNumber.length > 0 && /^[/.\dA-Za-z]/.test(afterNumber)) return false
 const rest = match[2]?.trim()
 if (rest && rest.length > 0) {
 const sentenceStarters =
 /^(items?|things?|steps?|files?|lines?|bugs?|issues?|errors?|times?|minutes?|hours?|days?|seconds?|percent|%|th\b|st\b|nd\b|rd\b|of\b|in\b|at\b|to\b|the\b|a\b|an\b)/i
 if (sentenceStarters.test(rest)) return false
 }
 return true
}

/** the classifier — praise detection on normalized prompt. */
const isPositivePraise = (prompt: string): boolean => {
 const normalized = prompt.trim().toLowerCase().replace(/[.!?,'"]/g, "")
 const words = normalized.split(/\s+/)
 if (words.length > 2) return false
 if (POSITIVE_PRAISE_WORDS.has(normalized)) return true
 if (POSITIVE_PHRASES.has(normalized)) return true
 if (words.length === 2 && words.every((w) => POSITIVE_PRAISE_WORDS.has(w))) {
 return true
 }
 return false
}

/**
 * the classifier — system-injected text.
 *
 * Exported (renamed `isSystemTextPrompt`) so the prompt-router can check it
 * BEFORE calling classify(). This is handled with `process.exit(0)`
 * — emits NO additionalContext at all. The router mirrors
 * that by returning SAFE_DEFAULT and NOT invoking classify or telemetry on
 * system-text input.
 */
export const isSystemTextPrompt = (prompt: string): boolean =>
 SYSTEM_TEXT_PATTERNS.some((re) => re.test(prompt.trim()))

// ════════════════════════════════════════════════════════════════
// END this package VERBATIM PORT
// ════════════════════════════════════════════════════════════════

/**
 * Return a Classification synchronously when the prompt's shape forces the
 * answer per this package's pre-inference gates. Returns null for anything ambiguous
 * → caller delegates to Inference.
 *
 * Order matches the classifier: rating → praise → system-text → length.
 */
export const tryFastPath = (
 rawPrompt: string,
): Classification | null => {
 const prompt = rawPrompt ?? ""
 // Gate 1: explicit rating
 if (isExplicitRating(prompt)) {
 return {
 mode: "MINIMAL",
 tier: null,
 reason: "explicit rating",
 source: "fast-path",
 latencyMs: 0,
 }
 }
 // Gate 2: positive praise
 if (isPositivePraise(prompt)) {
 return {
 mode: "MINIMAL",
 tier: null,
 reason: "positive praise / acknowledgment",
 source: "fast-path",
 latencyMs: 0,
 }
 }
 // Gate 3: system text — handled by the prompt-router BEFORE this function
 // is called (mirrors process.exit(0) — no additionalContext at all).
 // We do NOT check it here; if the router somehow lets system text through,
 // it would fall to inference and Sonnet would classify it normally.
 //
 // Gate 4: short prompt
 if (prompt.length < MIN_PROMPT_LENGTH) {
 return {
 mode: "MINIMAL",
 tier: null,
 reason: "prompt too short for classification",
 source: "fast-path",
 latencyMs: 0,
 }
 }
 return null
}

/**
 * Env-var opt-out: when `CLAUDE_HOOKS_DISABLE_CLASSIFIER=1`, the subprocess
 * call is skipped and we return a deterministic fail-safe (ALGORITHM tier 3,
 * source: fail-safe). Useful for: CI runners without a `claude` CLI, perf
 * tests that measure dispatcher overhead independently, redteam scenarios
 * where the Algorithm path is not under test, and the doctor's
 * `--no-classifier` opt-out.
 *
 * Fast-path gates are still consulted first.
 */
const isClassifierDisabled = (): boolean => {
 const v = process.env["CLAUDE_HOOKS_DISABLE_CLASSIFIER"]
 return v === "1" || v === "true"
}

export interface ClassifyOptions {
 /** Recent conversation context (getRecentContext output). When present,
 * prepended to the user prompt as `CONTEXT:\n${context}\n\nCURRENT MESSAGE:...`
 * inside Inference. This is what makes the rule "single-word
 * approvals NEVER MINIMAL" actually fire — Sonnet needs the prior turn. */
 readonly context?: string
}

/**
 * Full classify pipeline. Returns the fast-path answer when one exists;
 * otherwise asks the Inference service (unless disabled by env). Never fails.
 */
export const classify = (
 prompt: string,
 opts?: ClassifyOptions,
): Effect.Effect<Classification, never, Inference | ClaudeSubprocess> => {
 const fast = tryFastPath(prompt)
 if (fast !== null) return Effect.succeed(fast)
 if (isClassifierDisabled()) {
 return Effect.succeed({
 mode: "ALGORITHM",
 tier: 3,
 reason: "classifier disabled via CLAUDE_HOOKS_DISABLE_CLASSIFIER",
 source: "fail-safe",
 latencyMs: 0,
 })
 }
 return Effect.flatMap(Inference, (svc) =>
 svc.classify(prompt, opts?.context !== undefined ? { context: opts.context } : undefined),
 )
}

/**
 * Render a Classification as the canonical additionalContext line. Mirrors
 * the classifier (emitAdditionalContext) byte-for-byte:
 * ALGORITHM with tier: "MODE: ALGORITHM | TIER: E${tier} | REASON: ... | SOURCE: classifier"
 * else: "MODE: ${mode} | REASON: ... | SOURCE: classifier"
 *
 * SOURCE in additionalContext collapses fast-path → "classifier" (this package hard-
 * codes "classifier" for both deterministic gates and subprocess on line 60).
 * Only "fail-safe" survives as a distinct value in additionalContext per
 * the Algorithm v6.3.0. The "fast-path" distinction is preserved in
 * telemetry only (the classifier vs line 1023) — that's what auditors
 * want for the classifier-vs-fail-safe ratio.
 */
export const renderClassificationLine = (c: Classification): string => {
 const sourceForLine = c.source === "fail-safe" ? "fail-safe" : "classifier"
 if (c.mode === "ALGORITHM" && c.tier !== null) {
 return `MODE: ALGORITHM | TIER: E${c.tier} | REASON: ${c.reason} | SOURCE: ${sourceForLine}`
 }
 return `MODE: ${c.mode} | REASON: ${c.reason} | SOURCE: ${sourceForLine}`
}

/** Re-exported for callers that need the type without re-importing. */
export type { Tier }
