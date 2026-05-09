/**
 * Recent-conversation context extractor.
 *
 * Why this exists: the classifier rubric's "single-word approval" rule (a
 * "yes" after a multi-step proposal must inherit the proposal's mode and
 * tier, not classify as MINIMAL) only fires when Sonnet can see the prior
 * turn. The dispatcher feeds the last N turns into the user prompt as
 * `CONTEXT:\n${context}\n\nCURRENT MESSAGE:\n${cleanPrompt}`. Without it,
 * single-word approvals would silently downgrade to MINIMAL.
 *
 * The `transcript_path` is a JSONL file Claude Code writes per-session.
 * Each line is `{type: "user"|"assistant"|..., message?: {content}}`.
 * Default window is the last 6 turns. For classification we always
 * include assistant turns because that's where the "multi-step proposal"
 * lives.
 */

import { existsSync, readFileSync } from "node:fs"

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
 * the classifier — same try/catch envelopes, same 200-char
 * user / 150-char assistant slicing, same SUMMARY-line extraction for
 * assistant turns (the classifier — captures the assistant's compressed
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
 // the classifier: prefer SUMMARY: line if present.
 const summaryMatch = text.match(/SUMMARY:\s*([^\n]+)/i)
 const summarySnippet = summaryMatch?.[1]
 turns.push({
 role: "Assistant",
 text: summarySnippet !== undefined ? summarySnippet : text.slice(0, 150),
 })
 }
 }
 } catch {
 // Per-line parse error — skip and continue.
 }
 }

 const recent = turns.slice(-maxTurns)
 if (recent.length === 0) return ""
 return recent.map((t) => `${t.role}: ${t.text}`).join("\n")
 } catch {
 return ""
 }
}
