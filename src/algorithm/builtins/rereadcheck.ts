/**
 * ReReadCheck built-in — VERIFY→LEARN final gate per Algorithm v6.3.0
 * (capability listed in `~/.claude/PAI/ALGORITHM/capabilities.md` line 17).
 *
 * Doctrine summary (PAI capabilities.md): "Re-read user's last message
 * verbatim; enumerate every explicit ask against what shipped; block
 * `phase: complete` on any ✗. Targets the 82% 'missed ask' complaint
 * cluster. MANDATORY at every tier — at E1 single-part it's a one-line
 * block. No fast-path exemption."
 *
 * PAI lists this as `*(inline doctrine step — no external tool)*` —
 * meaning the model performs the check inline. This module makes the
 * check programmatically callable so the model can pipe its own draft
 * through it AND get a structured pass/fail report. Hooks can also use
 * it (e.g. an ISA Verification-section parser pre-flight).
 *
 * Algorithm:
 *   1. Tokenize the user prompt into "explicit asks" — sentences/clauses
 *      that contain an imperative verb or a question mark, plus any
 *      explicit numbered/bulleted item.
 *   2. For each ask, search the assistant's draft response for either a
 *      lexical match of the key noun, an explicit acknowledgement
 *      ("done", "shipped", "✓", "yes"), or evidence of action (a code
 *      fence, a bullet, etc.).
 *   3. Return the unmet asks. Empty array = ok.
 *
 * Heuristic, not perfect — surfaces the obvious misses doctrine targets
 * (the "you asked for X and I shipped Y" failure mode). False negatives
 * possible for paraphrase-heavy responses; false positives possible for
 * meta-prompts. Caller decides what to do with the verdict.
 */

export interface ExplicitAsk {
  /** Original sentence/clause as it appeared in the user prompt. */
  readonly text: string
  /** Approximate ordinal in the prompt (1-based). Useful for messages. */
  readonly index: number
  /** Detected category — informational. */
  readonly kind: "imperative" | "question" | "list-item"
}

export interface ReReadCheckReport {
  /** All explicit asks parsed from the user prompt. */
  readonly asks: ReadonlyArray<ExplicitAsk>
  /** Subset of `asks` that the assistant draft does NOT appear to address. */
  readonly unmet: ReadonlyArray<ExplicitAsk>
  /** True iff `unmet` is empty. */
  readonly ok: boolean
  /**
   * Single-line guidance suitable for stderr / additionalContext.
   * Empty when ok.
   */
  readonly message: string
}

const IMPERATIVE_VERBS: ReadonlySet<string> = new Set([
  "add",
  "build",
  "create",
  "make",
  "implement",
  "fix",
  "remove",
  "delete",
  "rename",
  "move",
  "rewrite",
  "refactor",
  "update",
  "explain",
  "list",
  "show",
  "describe",
  "summarize",
  "audit",
  "review",
  "verify",
  "check",
  "test",
  "run",
  "deploy",
  "ship",
  "write",
  "draft",
  "design",
  "ensure",
  "include",
])

const ACK_TOKENS: ReadonlyArray<string> = [
  "✓",
  "[x]",
  "[X]",
  "done",
  "shipped",
  "implemented",
  "added",
  "fixed",
  "removed",
  "updated",
  "covered",
]

const splitSentences = (text: string): ReadonlyArray<string> =>
  text
    .replace(/\r/g, "")
    .split(/(?<=[.?!])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

/**
 * Extract the first N words. Sentences starting with a conjunction
 * ("Then run X") are common — checking only word[0] would miss the
 * imperative. We scan the first 3 alphabetic tokens.
 */
const firstWords = (s: string, n: number): ReadonlyArray<string> => {
  const words: string[] = []
  const re = /[A-Za-z]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null && words.length < n) {
    words.push(m[0].toLowerCase())
  }
  return words
}

const startsWithImperative = (s: string): boolean =>
  firstWords(s, 3).some((w) => IMPERATIVE_VERBS.has(w))

const splitListItems = (text: string): ReadonlyArray<string> => {
  const out: string[] = []
  for (const rawLine of text.split("\n")) {
    const m = rawLine.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/)
    if (m && m[1] !== undefined) out.push(m[1].trim())
  }
  return out
}

/**
 * Extract explicit asks from a user prompt. Uses three signals:
 *   - sentences starting with an imperative verb
 *   - sentences ending with `?`
 *   - bulleted/numbered list items
 *
 * Each ask is returned at most once even if multiple signals match.
 */
export const extractExplicitAsks = (
  prompt: string,
): ReadonlyArray<ExplicitAsk> => {
  const asks: ExplicitAsk[] = []
  const seen = new Set<string>()
  let counter = 0
  const push = (text: string, kind: ExplicitAsk["kind"]): void => {
    const key = text.toLowerCase().replace(/\s+/g, " ").trim()
    if (key.length === 0 || seen.has(key)) return
    seen.add(key)
    counter += 1
    asks.push({ text, index: counter, kind })
  }
  for (const sentence of splitSentences(prompt)) {
    if (sentence.endsWith("?")) push(sentence, "question")
    else if (startsWithImperative(sentence)) push(sentence, "imperative")
  }
  for (const item of splitListItems(prompt)) {
    push(item, "list-item")
  }
  return asks
}

/**
 * Lightweight evidence test: does the draft mention each ask's key
 * content noun OR an acknowledgement marker following any noun from the
 * ask? We extract the longest noun-ish word (length >= 4) from the ask
 * and look for it in the draft (case-insensitive substring).
 */
const askIsCovered = (ask: ExplicitAsk, draft: string): boolean => {
  const lowDraft = draft.toLowerCase()
  // Acknowledgement scan — if any ack token AND any noun-ish word from the
  // ask appears in the draft, treat as covered.
  const allWords = ask.text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !IMPERATIVE_VERBS.has(w))
  const askWords = allWords.filter((w) => w.length >= 4)
  if (askWords.length === 0) {
    // No long noun — fall back to "any non-imperative token from ask
    // appears in draft" so short-noun asks like "Add foo bar." still
    // resolve when the draft mentions "foo" or "bar".
    if (allWords.length === 0) {
      return lowDraft.includes(ask.text.toLowerCase())
    }
    return allWords.some((w) => lowDraft.includes(w))
  }
  // Any noun present?
  const nounPresent = askWords.some((w) => lowDraft.includes(w))
  if (!nounPresent) return false
  // Heuristic: noun present AND any ack token nearby OR draft mentions the
  // ask noun more than once (signals discussion, not just echo).
  if (ACK_TOKENS.some((t) => lowDraft.includes(t.toLowerCase()))) return true
  // Multiple noun mentions = discussion of the topic.
  for (const w of askWords) {
    let count = 0
    let idx = lowDraft.indexOf(w)
    while (idx !== -1 && count < 2) {
      count += 1
      idx = lowDraft.indexOf(w, idx + 1)
    }
    if (count >= 2) return true
  }
  return false
}

export const rereadCheck = (
  userPrompt: string,
  assistantDraft: string,
): ReReadCheckReport => {
  const asks = extractExplicitAsks(userPrompt)
  const unmet = asks.filter((a) => !askIsCovered(a, assistantDraft))
  const ok = unmet.length === 0
  const message = ok
    ? ""
    : `ReReadCheck: ${unmet.length} explicit ask(s) appear unaddressed: ` +
      unmet
        .map(
          (a) =>
            `[${a.index}/${a.kind}] "${a.text.slice(0, 80)}${a.text.length > 80 ? "..." : ""}"`,
        )
        .join("; ")
  return { asks, unmet, ok, message }
}
