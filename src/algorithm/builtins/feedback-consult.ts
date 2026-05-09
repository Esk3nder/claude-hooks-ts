/**
 * FeedbackMemoryConsult built-in — capability listed in Algorithm v6.3.0
 * line 45 / `~/.claude/PAI/ALGORITHM/capabilities.md` line 13.
 *
 * Doctrine summary: "First step of PLAN at Extended+. Before committing to
 * approach, grep ~/.claude/projects/${HARNESS_USER_DIR}/memory/feedback_*.md
 * by task keywords. Prevents repeating mistakes already documented. Turns
 * the memory system from write-only diary into active guardrail."
 *
 * PAI invokes this via `Bash('rg -l "KEYWORDS" ...')` — model-side. This
 * module is the in-process equivalent: scan a feedback directory for
 * memos whose body matches the supplied keywords, return ranked excerpts.
 *
 * Path adaptation: PAI uses `~/.claude/projects/${HARNESS_USER_DIR}/memory/`
 * — a per-user, harness-injected directory. This package uses
 * `<repo>/.claude-hooks/feedback/` — per-repo, mirrors the established
 * `.claude-hooks/` convention used by checkpoint allowlist, probes, and
 * regenerate.yaml. The doctrine pattern is the same: prior-mistake memos
 * grepped by keyword before committing to an approach.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const FEEDBACK_SUBPATH = [".claude-hooks", "feedback"] as const

export const feedbackDirFor = (root: string = process.cwd()): string =>
  join(root, ...FEEDBACK_SUBPATH)

/** Default cap on results — enough to surface signal without flooding context. */
const DEFAULT_MAX_RESULTS = 5

/** Cap on per-memo excerpt length. */
const EXCERPT_CHARS = 320

export interface FeedbackMatch {
  /** Absolute path to the memo file. */
  readonly path: string
  /** Filename basename (e.g. "feedback_classifier.md") for display. */
  readonly name: string
  /** Number of distinct supplied keywords found in the memo body. */
  readonly hits: number
  /** First passage in the memo containing any keyword, capped at 320 chars. */
  readonly excerpt: string
}

const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Build a case-insensitive boundary-matching regex from keywords. Empty
 * keywords are ignored. If all keywords are empty, returns null (caller
 * treats as "no signal, return nothing").
 */
const buildKeywordRegex = (keywords: ReadonlyArray<string>): RegExp | null => {
  const cleaned = keywords
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .map(escapeRegex)
  if (cleaned.length === 0) return null
  return new RegExp(`\\b(?:${cleaned.join("|")})\\b`, "gi")
}

/**
 * Find the most informative excerpt around a keyword hit — pull the
 * paragraph (text between blank lines) containing the first match,
 * clipped to EXCERPT_CHARS.
 */
const buildExcerpt = (body: string, re: RegExp): string => {
  re.lastIndex = 0
  const m = re.exec(body)
  if (m === null || m.index === undefined) {
    return body.slice(0, EXCERPT_CHARS)
  }
  // Paragraph bounds: blank-line on either side.
  const before = body.slice(0, m.index).lastIndexOf("\n\n")
  const after = body.indexOf("\n\n", m.index)
  const start = before >= 0 ? before + 2 : 0
  const end = after >= 0 ? after : body.length
  const para = body.slice(start, end).trim()
  return para.length > EXCERPT_CHARS ? `${para.slice(0, EXCERPT_CHARS - 3)}...` : para
}

/**
 * Count distinct keywords (regardless of how many times each appears) so
 * a memo mentioning 3 of 4 keywords ranks above one mentioning the same
 * keyword 10 times.
 */
const countDistinctHits = (
  body: string,
  keywords: ReadonlyArray<string>,
): number => {
  const lowBody = body.toLowerCase()
  let hits = 0
  for (const k of keywords) {
    const trimmed = k.trim().toLowerCase()
    if (trimmed.length === 0) continue
    if (lowBody.includes(trimmed)) hits += 1
  }
  return hits
}

export interface ConsultOptions {
  readonly maxResults?: number
  /** Override default feedback directory location. */
  readonly dir?: string
}

/**
 * Scan the feedback directory for memos whose bodies contain any of the
 * supplied keywords. Returns matches sorted by (distinct-hit-count desc,
 * mtime desc). Best-effort — read errors per-memo are silently skipped.
 *
 * Returns [] when:
 *   - no keywords
 *   - feedback dir absent
 *   - no memos match
 */
export const consultFeedback = (
  keywords: ReadonlyArray<string>,
  opts?: ConsultOptions,
): ReadonlyArray<FeedbackMatch> => {
  const re = buildKeywordRegex(keywords)
  if (re === null) return []
  const dir = opts?.dir ?? feedbackDirFor()
  if (!existsSync(dir)) return []
  let entries: ReadonlyArray<string>
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const matches: Array<FeedbackMatch & { mtime: number }> = []
  for (const name of entries) {
    if (!name.endsWith(".md")) continue
    const path = join(dir, name)
    let body: string
    let mtime = 0
    try {
      body = readFileSync(path, "utf-8")
      mtime = statSync(path).mtimeMs
    } catch {
      continue
    }
    const hits = countDistinctHits(body, keywords)
    if (hits === 0) continue
    matches.push({
      path,
      name,
      hits,
      excerpt: buildExcerpt(body, re),
      mtime,
    })
  }
  matches.sort((a, b) => b.hits - a.hits || b.mtime - a.mtime)
  const max = opts?.maxResults ?? DEFAULT_MAX_RESULTS
  return matches.slice(0, max).map(({ mtime: _mtime, ...rest }) => {
    void _mtime
    return rest
  })
}

/**
 * Render a compact additionalContext block summarizing matches. Empty
 * string when no matches — caller decides whether to emit at all.
 */
export const renderConsultBlock = (
  matches: ReadonlyArray<FeedbackMatch>,
): string => {
  if (matches.length === 0) return ""
  const header = `FeedbackMemoryConsult: ${matches.length} prior memo(s) match`
  const body = matches
    .map((m) => `- ${m.name} (${m.hits} hit${m.hits === 1 ? "" : "s"}): ${m.excerpt.split("\n")[0]?.slice(0, 200) ?? ""}`)
    .join("\n")
  return `${header}\n${body}`
}
