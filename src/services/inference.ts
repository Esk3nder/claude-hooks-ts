/**
 * Inference service — Sonnet classifier implementing TASK 3 of the
 * Algorithm v6.3.0 classifier doctrine.
 *
 * Faithful port of the Algorithm spec. Three deliberate adaptations from
 * the upstream classifier doctrine are documented inline (and only there):
 *   1. The upstream hook does TASK 1 (tab title) + TASK 2 (session name) +
 *      TASK 3 (mode/tier) in one inference call. This package only needs
 *      TASK 3, so the rubric below contains TASK 3 verbatim and drops
 *      TASK 1/2.
 *   2. The upstream hook resolves principal/assistant names via
 *      getPrincipal/getIdentity. This package is identity-free
 *      (CLAUDE-HOOKS-TS scope), so the rubric uses the literal placeholder
 *      "the user" / "the assistant". Classifier decisions don't depend on
 *      the names.
 *   3. The upstream `inference()` helper wraps the chokepoint and parses
 *      JSON. This package wires the same shape via `ClaudeSubprocess.spawn`
 *      + JSON parse.
 *
 * Everything else — model tier (Sonnet), classifier prompt body, JSON
 * output schema, fail-safe behavior, env scrubs,
 * --exclude-dynamic-system-prompt-sections cache flag, 25s timeout,
 * cleanPrompt sanitization, image-args branch, CONTEXT/CURRENT MESSAGE
 * framing — mirrors the upstream behavior exactly.
 */

import { Context, Effect, Layer } from "effect"
import { ClaudeSubprocess } from "./claude-subprocess.ts"

export type Mode = "MINIMAL" | "NATIVE" | "ALGORITHM"
/** Numeric tiers 1-5 internally — mirrors the upstream InferenceResult.tier shape.
 *  The `E${tier}` prefix is applied only at additionalContext emission. */
export type Tier = 1 | 2 | 3 | 4 | 5
/**
 * Three-valued source. the upstream spec distinguishes "fast-path" (deterministic gate
 * hit) from "classifier" (Sonnet subprocess) in telemetry (the upstream classifier
 * vs line 1023). The additionalContext line itself only ever shows
 * "classifier" or "fail-safe" (the upstream classifier hardcodes "classifier" for both
 * fast-path and subprocess paths) — see renderClassificationLine.
 */
export type ClassificationSource = "classifier" | "fast-path" | "fail-safe"

export interface Classification {
  readonly mode: Mode
  /** Present iff MODE === "ALGORITHM". */
  readonly tier: Tier | null
  readonly reason: string
  readonly source: ClassificationSource
  readonly latencyMs: number
}

export const FAIL_SAFE: Omit<Classification, "latencyMs" | "reason"> = {
  mode: "ALGORITHM",
  tier: 3,
  source: "fail-safe",
}

/**
 * Classifier rubric — PORTED VERBATIM from the spec's
 * the upstream classifier doctrine, TASK 3
 * (lines 734-766). Re-port required if TASK 3 of the classifier doctrine changes; doctrine version
 * pinned to Algorithm v6.3.0.
 *
 * Editing this string outside of a "re-port from the spec" PR is a doctrine
 * violation. Tests in inference.test.ts pin every doctrine clause.
 */
export const CLASSIFIER_SYSTEM_PROMPT = `You analyze user messages to extract what response mode is required. The user is the only one sending prompts. The AI assistant responds.

## TASK 3: MODE + TIER CLASSIFICATION
Classify the prompt into a response mode for the assistant. When CONTEXT is provided, use it to disambiguate the CURRENT MESSAGE. The CURRENT MESSAGE is the only thing being classified; context is interpretive aid.

Mode rules:
- MINIMAL: greetings, ratings, single-token acknowledgments ("ok", "thanks", "8/10", "sounds good") — UNLESS context shows the prompt is approving a multi-step plan from prior turns. In that case classify what the conversation makes the prompt mean.
- NATIVE: a single fact lookup, a single-line edit on a named file, or one command run — AND no new artifact is created (no new file, function, feature, route, table, hook, skill, agent, integration, page) — AND no multi-step plan is required.
- ALGORITHM: everything else. Always pick ALGORITHM for: any build/create/make/implement/design/develop/scaffold/prototype/architect/refactor/migrate/integrate request, anything touching multiple files, anything ambiguous in scope, anything affecting doctrine / system-prompt / hooks / CLAUDE.md / Algorithm / ISA, anything spanning multiple projects, anything that requires investigation or audit, any meta-question about how the system itself works, any single-word approval ("yes", "do it", "go", "ship it") whose context is a multi-step proposal.

Tier (only when mode is ALGORITHM; null otherwise):
- 1 Standard: trivial single-file work that creates something new (~<90s).
- 2 Extended: single-domain task spanning a few files, quality must be extraordinary (~3min).
- 3 Advanced: substantial multi-file work, multi-step plan, root-cause investigation (~10min).
- 4 Deep: cross-cutting design, doctrine changes, architecture changes, cross-vendor audit needed (~30min).
- 5 Comprehensive: research / build with no time pressure (>2h).

Bias: when in doubt between NATIVE and ALGORITHM-1, pick ALGORITHM-1. When in doubt between two ALGORITHM tiers, pick the higher one. Casual phrasing ("build me a quick X") does NOT downgrade — scope hides inside short sentences. Single-word approvals to multi-step plans are NEVER MINIMAL — they inherit the proposal's mode and tier.

Mode examples:
- "thanks" with no context → mode MINIMAL, tier null, reason "acknowledgment"
- "yes" after assistant proposed three numbered fixes → mode ALGORITHM, tier 3, reason "approves multi-step plan from prior turn"
- "what time is it" → mode NATIVE, tier null, reason "single fact lookup"
- "fix the typo on line 12 of foo.ts" → mode NATIVE, tier null, reason "single-line edit on a named file"
- "build me a complex application" → mode ALGORITHM, tier 3, reason "new app creation, multi-file substantial work"
- "audit the algorithm and update doctrine" → mode ALGORITHM, tier 4, reason "doctrine change, cross-cutting"

OUTPUT FORMAT (JSON only, single object on one line, no prose, no markdown):
{
  "mode": "MINIMAL" | "NATIVE" | "ALGORITHM",
  "tier": 1 | 2 | 3 | 4 | 5 | null,
  "mode_reason": "<one short sentence>"
}`

/**
 * Default subprocess timeout — mirrors the upstream classifier (`timeout: 25000`).
 * The dispatcher's UserPromptSubmit cap (30s) gives 5s of overhead headroom.
 */
const DEFAULT_TIMEOUT_MS = 25_000

const MODES: ReadonlySet<Mode> = new Set(["MINIMAL", "NATIVE", "ALGORITHM"])
const VALID_TIERS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5])

/**
 * cleanPrompt — PORTED VERBATIM from the upstream classifier.
 * Strips HTML/tag-shaped tokens, normalizes whitespace, caps at 1000 chars
 * before sending to the classifier. Prevents `<system-reminder>` blocks and
 * other injected markup from contaminating Sonnet's input.
 */
export const cleanPrompt = (prompt: string): string =>
  prompt.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1000)

/**
 * Build the user prompt sent to the classifier. The upstream classifier framing:
 *   `CONTEXT:\n${context}\n\nCURRENT MESSAGE:\n${cleanPrompt}`
 * Without context, just the cleaned prompt.
 */
export const buildUserPrompt = (
  rawPrompt: string,
  context?: string,
): string => {
  const cleaned = cleanPrompt(rawPrompt)
  if (context !== undefined && context.length > 0) {
    return `CONTEXT:\n${context}\n\nCURRENT MESSAGE:\n${cleaned}`
  }
  return cleaned
}

interface ParseSuccess {
  readonly _tag: "ok"
  readonly mode: Mode
  readonly tier: Tier | null
  readonly reason: string
}
interface ParseFailure {
  readonly _tag: "fail"
  readonly message: string
}

/**
 * Parse the classifier's JSON response. mirrors the upstream classifier — extracts
 * `mode`, `tier`, `mode_reason`. Tolerates leading/trailing prose and code
 * fences (some Sonnet runs wrap the JSON despite the rubric).
 */
export const parseClassifierResponse = (
  raw: string,
): ParseSuccess | ParseFailure => {
  const stripped = raw
    .replace(/^```(?:json)?\n?/m, "")
    .replace(/```\s*$/m, "")
    .trim()
  if (stripped.length === 0) {
    return { _tag: "fail", message: "empty response" }
  }
  const objectMatch = stripped.match(/\{[\s\S]*\}/)
  if (!objectMatch) {
    return { _tag: "fail", message: "no JSON object in response" }
  }
  let obj: unknown
  try {
    obj = JSON.parse(objectMatch[0])
  } catch (err) {
    return { _tag: "fail", message: `JSON parse: ${String(err).slice(0, 80)}` }
  }
  if (typeof obj !== "object" || obj === null) {
    return { _tag: "fail", message: "JSON is not an object" }
  }
  const r = obj as { mode?: unknown; tier?: unknown; mode_reason?: unknown }
  if (typeof r.mode !== "string" || !MODES.has(r.mode as Mode)) {
    return { _tag: "fail", message: "missing or invalid mode" }
  }
  const mode = r.mode as Mode
  let tier: Tier | null = null
  if (r.tier === null || r.tier === undefined) {
    tier = null
  } else if (typeof r.tier === "number" && VALID_TIERS.has(r.tier)) {
    tier = r.tier as Tier
  } else {
    return { _tag: "fail", message: `invalid tier: ${String(r.tier)}` }
  }
  if (mode === "ALGORITHM" && tier === null) {
    return { _tag: "fail", message: "ALGORITHM mode requires a tier" }
  }
  if (mode !== "ALGORITHM") tier = null
  // B6: whitespace-only mode_reason was passing the length check, leaking
  // useless "   " strings into additionalContext. Trim before length check.
  const trimmedReason =
    typeof r.mode_reason === "string" ? r.mode_reason.trim() : ""
  const reason = trimmedReason.length > 0 ? trimmedReason : "(no reason given)"
  return { _tag: "ok", mode, tier, reason }
}

export interface ClassifyOptions {
  readonly timeoutMs?: number
  /** Recent conversation context (getRecentContext output). When present,
   *  prepended as `CONTEXT:\n${context}\n\nCURRENT MESSAGE:\n${cleanPrompt}`.
   *  This is what makes the doctrine rule "single-word approvals NEVER
   *  MINIMAL" actually fire — Sonnet needs the prior turn to disambiguate. */
  readonly context?: string
  /** Optional image file paths. Mirrors the upstream classifier — when present,
   *  Read tool is enabled and `@path` references are prepended. The classifier
   *  does not currently take images, but this is a faithful port. */
  readonly imagePaths?: ReadonlyArray<string>
}

export interface InferenceApi {
  /**
   * Classify a user prompt. Always succeeds — failures collapse to FAIL_SAFE.
   * The Effect requires a ClaudeSubprocess in its environment.
   */
  readonly classify: (
    prompt: string,
    opts?: ClassifyOptions,
  ) => Effect.Effect<Classification, never, ClaudeSubprocess>
}

export class Inference extends Context.Tag("Inference")<
  Inference,
  InferenceApi
>() {}

/**
 * Build CLI args. Mirrors the upstream classifier exactly, including the
 * image-args branch that swaps `--tools ''` for `--allowedTools Read`.
 * `--model sonnet` because Algorithm v6.3.0 line 73 specifies a Sonnet
 * classifier.
 */
const buildArgs = (hasImages: boolean): ReadonlyArray<string> => [
  "--print",
  "--model",
  "sonnet",
  ...(hasImages ? ["--allowedTools", "Read"] : ["--tools", ""]),
  "--output-format",
  "text",
  "--exclude-dynamic-system-prompt-sections",
  "--setting-sources",
  "",
  "--system-prompt",
  CLASSIFIER_SYSTEM_PROMPT,
]

/**
 * Build the stdin payload. The upstream classifier prepends @-references
 * for image inputs; otherwise just the user prompt (already CONTEXT-framed
 * and cleaned by buildUserPrompt).
 */
const buildStdin = (
  framedPrompt: string,
  imagePaths?: ReadonlyArray<string>,
): string => {
  if (imagePaths === undefined || imagePaths.length === 0) return framedPrompt
  const refs = imagePaths.map((p) => `@${p}`).join("\n")
  return `${refs}\n\n${framedPrompt}`
}

const liveImpl: InferenceApi = {
  classify: (prompt, opts) =>
    Effect.gen(function* () {
      const subproc = yield* ClaudeSubprocess
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const hasImages = opts?.imagePaths !== undefined && opts.imagePaths.length > 0
      const framed = buildUserPrompt(prompt, opts?.context)
      const stdin = buildStdin(framed, opts?.imagePaths)
      const args = buildArgs(hasImages)

      const result = yield* subproc
        .spawn(args, { stdin, timeoutMs })
        .pipe(
          Effect.catchAll((err) =>
            Effect.succeed({
              stdout: "",
              stderr: `spawn-error: ${String(err)}`,
              exitCode: -1,
              latencyMs: 0,
              timedOut: false,
            }),
          ),
        )

      if (result.timedOut) {
        return {
          ...FAIL_SAFE,
          reason: `classifier timeout after ${timeoutMs}ms`,
          latencyMs: result.latencyMs,
        }
      }
      if (result.exitCode !== 0) {
        return {
          ...FAIL_SAFE,
          reason: `classifier exit ${result.exitCode}: ${result.stderr.slice(0, 120).trim()}`,
          latencyMs: result.latencyMs,
        }
      }
      const parsed = parseClassifierResponse(result.stdout)
      if (parsed._tag === "fail") {
        return {
          ...FAIL_SAFE,
          reason: `parse-fail: ${parsed.message}`,
          latencyMs: result.latencyMs,
        }
      }
      return {
        mode: parsed.mode,
        tier: parsed.tier,
        reason: parsed.reason,
        source: "classifier",
        latencyMs: result.latencyMs,
      }
    }),
}

export const InferenceLive = Layer.succeed(Inference, Inference.of(liveImpl))

/**
 * Test layer: deterministic responder. Receives prompt AND opts so tests can
 * assert that context/imagePaths were threaded through.
 */
export const InferenceTest = (
  responder: (
    prompt: string,
    opts?: ClassifyOptions,
  ) => Classification = () => ({
    ...FAIL_SAFE,
    reason: "test default",
    latencyMs: 0,
  }),
): Layer.Layer<Inference> =>
  Layer.succeed(
    Inference,
    Inference.of({
      classify: (prompt, opts) => Effect.sync(() => responder(prompt, opts)),
    }),
  )
