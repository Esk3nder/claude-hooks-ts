import { Effect } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { NO_DECISION } from "../schema/decisions.ts"
import { parseFailure } from "../policies/failure-parsers.ts"
import { DEFAULT_POLICY } from "../services/policy-config.ts"

const MAX_CHARS = 800
const secretValuePatterns = DEFAULT_POLICY.secretValuePatterns.map(
  (pattern) =>
    new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    ),
)

const truncate = (s: string, n: number): string =>
  s.length < n ? s : s.slice(0, n - 2) + "…"

const redactSecrets = (s: string): string => {
  let out = s
  for (const pattern of secretValuePatterns) {
    pattern.lastIndex = 0
    out = out.replace(pattern, "[REDACTED]")
  }
  return out
}

const errorToText = (err: unknown): string => {
  if (typeof err === "string") return err
  if (err === null || err === undefined) return ""
  if (typeof err === "object") {
    const e = err as { message?: unknown; stderr?: unknown; stdout?: unknown }
    if (typeof e.message === "string") return e.message
    if (typeof e.stderr === "string") return e.stderr
    if (typeof e.stdout === "string") return e.stdout
    return ""
  }
  return String(err)
}

export const handlePostToolUseFailure = (
  payload: HookPayload,
): Effect.Effect<HookDecision> =>
  Effect.sync(() => {
    if (payload._tag !== "PostToolUseFailure") return NO_DECISION
    const text = errorToText(payload.error)
    if (text.trim().length === 0) return NO_DECISION
    // Per the official spec, payloads carry an `error_type` hint
    // (e.g. "vitest", "tsc"). Prefer it as the category when present;
    // otherwise fall back to heuristic detection in `parseFailure`.
    const parsed = parseFailure(text)
    const category = payload.error_type ?? parsed.category
    const top = redactSecrets(parsed.topLines.slice(0, 3).join(" | "))
    const pathInfo = parsed.likelyPath ?? "unknown location"
    const summary =
      `Failure summary: ${category} failed in ${pathInfo} because ${top}. ` +
      `Next likely action: inspect ${pathInfo}.`
    const additionalContext = truncate(summary, MAX_CHARS)
    const decision: HookDecision = {
      hookSpecificOutput: {
        hookEventName: "PostToolUseFailure",
        additionalContext,
      },
    }
    return decision
  })
