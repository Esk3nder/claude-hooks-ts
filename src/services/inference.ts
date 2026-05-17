/**
 * Inference service — Sonnet classifier that decides MODE + TIER for a
 * given user prompt. Identity-free: the rubric uses literal placeholders
 * "the user" / "the assistant" and never resolves real principal names.
 *
 * Configuration: model `sonnet`, --exclude-dynamic-system-prompt-sections
 * for cache friendliness, 25s timeout (envelope under the dispatcher's
 * 30s UserPromptSubmit cap). On any failure the classifier returns
 * FAIL_SAFE (ALGORITHM E3) so the model never blocks on classifier
 * trouble.
 */

import { Context, Effect, Layer } from "effect"
import { ClaudeSubprocess } from "./claude-subprocess.ts"
import { durationMillis, loadRuntimeConfig } from "./runtime-config.ts"
import { reportHookFailure } from "./hook-failure.ts"

export type Mode = "MINIMAL" | "NATIVE" | "ALGORITHM"
/** Numeric tiers 1-5 internally — mirrors the InferenceResult.tier shape.
 * The `E${tier}` prefix is applied only at additionalContext emission. */
export type Tier = 1 | 2 | 3 | 4 | 5
/**
 * Three-valued source: `fast-path` for a deterministic gate hit, `classifier`
 * for a Sonnet subprocess decision, `fail-safe` for the conservative default
 * after any error. Telemetry preserves all three; the additionalContext line
 * shown to the model collapses fast-path → classifier (see
 * renderClassificationLine).
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
 * Canonical classifier rubric for Algorithm v6.3.0. Tests in
 * inference.test.ts pin every clause; if you change the rubric, update
 * the tests in the same commit.
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
 * Default subprocess timeout — implements the classifier (`timeout: 25000`).
 * The dispatcher's UserPromptSubmit cap (30s) gives 5s of overhead headroom.
 */
const DEFAULT_TIMEOUT_MS = 25_000

const MODES: ReadonlySet<Mode> = new Set(["MINIMAL", "NATIVE", "ALGORITHM"])
const VALID_TIERS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5])

/**
 * cleanPrompt — the classifier.
 * Strips HTML/tag-shaped tokens, normalizes whitespace, caps at 1000 chars
 * before sending to the classifier. Prevents `<system-reminder>` blocks and
 * other injected markup from contaminating Sonnet's input.
 */
export const cleanPrompt = (prompt: string): string =>
  prompt
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000)

/**
 * Build the user prompt sent to the classifier. The classifier framing:
 * `CONTEXT:\n${context}\n\nCURRENT MESSAGE:\n${cleanPrompt}`
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
 * Parse the classifier's JSON response. implements the classifier — extracts
 * `mode`, `tier`, `mode_reason`. Tolerates leading/trailing prose and code
 * fences (some Sonnet runs wrap the JSON despite the classifier rubric).
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
  // useless " " strings into additionalContext. Trim before length check.
  const trimmedReason =
    typeof r.mode_reason === "string" ? r.mode_reason.trim() : ""
  const reason = trimmedReason.length > 0 ? trimmedReason : "(no reason given)"
  return { _tag: "ok", mode, tier, reason }
}

export interface ClassifyOptions {
  readonly timeoutMs?: number
  /** Recent conversation context (getRecentContext output). When present,
   * prepended as `CONTEXT:\n${context}\n\nCURRENT MESSAGE:\n${cleanPrompt}`.
   * This is what makes the rule "single-word approvals NEVER
   * MINIMAL" actually fire — Sonnet needs the prior turn to disambiguate. */
  readonly context?: string
  /** Optional image file paths. Mirrors the classifier — when present,
   * Read tool is enabled and `@path` references are prepended. The classifier
   * does not currently take images, but this is a . */
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
 * Build CLI args. Mirrors the classifier exactly, including the
 * image-args branch that swaps `--tools ''` for `--allowedTools Read`.
 * `--model sonnet` because Algorithm v6.3.0ifies a Sonnet
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
 * Build the stdin payload. The classifier prepends @-references
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

const classifierExitSummary = (exitCode: number, stderr: string): string => {
  const stderrBytes = Buffer.byteLength(stderr, "utf8")
  return stderrBytes > 0
    ? `classifier exit ${exitCode}; stderr redacted (${stderrBytes} bytes)`
    : `classifier exit ${exitCode}`
}

const liveImpl: InferenceApi = {
  classify: (prompt, opts) =>
    Effect.gen(function* () {
      const subproc = yield* ClaudeSubprocess
      const config = yield* loadRuntimeConfig
      const configuredTimeoutMs = durationMillis(config.classifierTimeoutMs)
      const timeoutMs =
        opts?.timeoutMs ??
        (configuredTimeoutMs > 0 ? configuredTimeoutMs : DEFAULT_TIMEOUT_MS)
      const hasImages =
        opts?.imagePaths !== undefined && opts.imagePaths.length > 0
      const framed = buildUserPrompt(prompt, opts?.context)
      const stdin = buildStdin(framed, opts?.imagePaths)
      const args = buildArgs(hasImages)

      const result = yield* subproc.spawn(args, { stdin, timeoutMs }).pipe(
        Effect.catchAll((err) =>
          reportHookFailure({
            kind: "subprocess_failed",
            event: "UserPromptSubmit",
            cause: err,
            hookSafe: true,
            context: { subprocess: "claude", op: "classifier.spawn" },
          }).pipe(
            Effect.as({
              stdout: "",
              stderr: `spawn-error: ${String(err)}`,
              exitCode: -1,
              latencyMs: 0,
              timedOut: false,
            }),
          ),
        ),
      )

      if (result.timedOut) {
        yield* reportHookFailure({
          kind: "subprocess_failed",
          event: "UserPromptSubmit",
          cause: `classifier timeout after ${timeoutMs}ms`,
          hookSafe: true,
          context: { subprocess: "claude", op: "classifier.spawn", timeout_ms: timeoutMs },
        })
        return {
          ...FAIL_SAFE,
          reason: `classifier timeout after ${timeoutMs}ms`,
          latencyMs: result.latencyMs,
        }
      }
      if (result.exitCode !== 0) {
        const reason = classifierExitSummary(result.exitCode, result.stderr)
        yield* reportHookFailure({
          kind: "subprocess_failed",
          event: "UserPromptSubmit",
          cause: reason,
          hookSafe: true,
          context: { subprocess: "claude", op: "classifier.spawn", exit_code: result.exitCode },
        })
        return {
          ...FAIL_SAFE,
          reason,
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
