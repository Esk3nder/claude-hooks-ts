import { Effect } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { parseFailure } from "../policies/failure-parsers.ts"

const MAX_CHARS = 800

const truncate = (s: string, n: number): string =>
  s.length < n ? s : s.slice(0, n - 2) + "…"

const errorToText = (err: unknown): string => {
  if (typeof err === "string") return err
  if (err === null || err === undefined) return ""
  if (typeof err === "object") {
    const e = err as { message?: unknown; stderr?: unknown; stdout?: unknown }
    if (typeof e.message === "string") return e.message
    if (typeof e.stderr === "string") return e.stderr
    if (typeof e.stdout === "string") return e.stdout
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return String(err)
}

export const handlePostToolUseFailure = (
  payload: HookPayload,
): Effect.Effect<HookDecision> =>
  Effect.sync(() => {
    if (payload._tag !== "PostToolUseFailure") return SAFE_DEFAULT
    const text = errorToText(payload.error)
    if (text.trim().length === 0) return SAFE_DEFAULT
    const parsed = parseFailure(text)
    const top = parsed.topLines.slice(0, 3).join(" | ")
    const pathInfo = parsed.likelyPath ?? "unknown location"
    const summary =
      `Failure summary: ${parsed.category} failed in ${pathInfo} because ${top}. ` +
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
