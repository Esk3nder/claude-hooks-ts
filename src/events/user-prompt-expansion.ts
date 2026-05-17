import { Effect } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { NO_DECISION } from "../schema/decisions.ts"
import { classifyPrompt } from "../policies/workflow-classifier.ts"

const HIGH_BLAST_RADIUS_TAGS = new Set<string>([
  "ops.deploy",
  "ops.migration",
])

const WARNING =
  "high-blast-radius command detected; verify scope before proceeding"

/**
 * UserPromptExpansion handler — fires when a slash command is expanded.
 * If the expanded prompt classifies as a deploy/migration workflow we inject
 * a one-line warning via ContextInjection. Otherwise NO_DECISION.
 */
export const handleUserPromptExpansion = (
  payload: HookPayload,
): Effect.Effect<HookDecision> =>
  Effect.sync(() => {
    if (payload._tag !== "UserPromptExpansion") return NO_DECISION
    const text = payload.expanded_prompt ?? payload.prompt ?? ""
    if (text.length === 0) return NO_DECISION
    const { workflow } = classifyPrompt(text)
    if (!HIGH_BLAST_RADIUS_TAGS.has(workflow)) return NO_DECISION
    const out: HookDecision = {
      hookSpecificOutput: {
        hookEventName: "UserPromptExpansion",
        additionalContext: WARNING,
      },
    }
    return out
  })
