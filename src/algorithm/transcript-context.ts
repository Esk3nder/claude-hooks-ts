/**
 * Recent-conversation context extractor — PORTED VERBATIM from PAI's
 * `getRecentContext` (PromptProcessing.hook.ts lines 774-809).
 *
 * Why this exists: the classifier rubric's "single-word approval" rule
 * (Algorithm v6.3.0 line 749, replicated in CLASSIFIER_SYSTEM_PROMPT) only
 * fires when Sonnet can see the prior turn. PAI feeds the last N turns into
 * the user prompt as `CONTEXT:\n${context}\n\nCURRENT MESSAGE:\n${cleanPrompt}`.
 * Without this, "yes" after a multi-step proposal classifies MINIMAL — the
 * exact failure mode the doctrine was written to prevent.
 *
 * The `transcript_path` is a JSONL file Claude Code writes to per-session.
 * Each line is `{type: "user"|"assistant"|..., message?: {content}}`. PAI
 * defaults to last 6 turns. `includeAssistant` was a PAI-internal toggle
 * for session-naming purposes (excluded for the first prompt to avoid
 * Algorithm scaffolding contamination); for classification we always include
 * assistant turns because that's where the "multi-step proposal" lives.
 */

import { existsSync, readFileSync } from "node:fs"

/** PAI line 774 default. */
const DEFAULT_MAX_TURNS = 6

interface Turn {
  readonly role: "User" | "Assistant"
  readonly text: string
}

/**
 * Read the transcript JSONL and return the last `maxTurns` turns formatted as
 * "Role: text" joined by newlines. Returns "" on any error or if the file
 * doesn't exist or contains no usable turns.
 *
 * Faithful port of PAI lines 774-808 — same try/catch envelopes, same 200-char
 * user / 150-char assistant slicing, same SUMMARY-line extraction for
 * assistant turns (PAI line 800 — captures the assistant's compressed
 * conclusion when present).
 */
export const getRecentContext = (
  transcriptPath: string | undefined,
  maxTurns: number = DEFAULT_MAX_TURNS,
  includeAssistant: boolean = true,
): string => {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return ""
    const content = readFileSync(transcriptPath, "utf-8")
    const lines = content.trim().split("\n")
    const turns: Turn[] = []

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as {
          type?: string
          message?: { content?: unknown }
        }
        if (entry.type === "user" && entry.message?.content !== undefined) {
          let text = ""
          if (typeof entry.message.content === "string") {
            text = entry.message.content
          } else if (Array.isArray(entry.message.content)) {
            text = entry.message.content
              .filter(
                (c: unknown): c is { type: string; text: string } => {
                  // B1 fix: validate BOTH type === "text" AND text is a string.
                  // Without the text-string check, entries like `{type:"text"}`
                  // (no text field) passed the filter, and the subsequent
                  // .map(c => c.text) produced literal "undefined" tokens.
                  if (typeof c !== "object" || c === null) return false
                  const o = c as { type?: unknown; text?: unknown }
                  return o.type === "text" && typeof o.text === "string"
                },
              )
              .map((c) => c.text)
              .join(" ")
          }
          if (text.trim()) {
            turns.push({ role: "User", text: text.slice(0, 200) })
          }
        }
        if (
          includeAssistant &&
          entry.type === "assistant" &&
          entry.message?.content !== undefined
        ) {
          const text =
            typeof entry.message.content === "string"
              ? entry.message.content
              : Array.isArray(entry.message.content)
                ? entry.message.content
                    .filter(
                      (c: unknown): c is { type: string; text: string } => {
                        // B1 fix: validate text field type, not just `type`.
                        if (typeof c !== "object" || c === null) return false
                        const o = c as { type?: unknown; text?: unknown }
                        return o.type === "text" && typeof o.text === "string"
                      },
                    )
                    .map((c) => c.text)
                    .join(" ")
                : ""
          if (text) {
            // PAI line 799-801: prefer SUMMARY: line if present.
            const summaryMatch = text.match(/SUMMARY:\s*([^\n]+)/i)
            const summarySnippet = summaryMatch?.[1]
            turns.push({
              role: "Assistant",
              text: summarySnippet !== undefined ? summarySnippet : text.slice(0, 150),
            })
          }
        }
      } catch {
        // Per-line parse error — skip and continue (PAI line 803).
      }
    }

    const recent = turns.slice(-maxTurns)
    if (recent.length === 0) return ""
    return recent.map((t) => `${t.role}: ${t.text}`).join("\n")
  } catch {
    return ""
  }
}
