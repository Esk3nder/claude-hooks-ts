/**
 * ISC criteria parser — PORTED VERBATIM from PAI's
 * ~/.claude/hooks/lib/isa-utils.ts lines 95-317.
 *
 * Surface mirrors PAI exactly:
 *   - CRITERIA_HEADING_RE          (PAI line 108)
 *   - CANONICAL_CRITERIA_HEADING   (PAI line 113)
 *   - extractCriteriaSection       (PAI line 118)
 *   - countCriteria                (PAI line 129)
 *   - CriterionEntry               (PAI line 184)
 *   - VALID_CATEGORIES             (PAI line 207)
 *   - parseCriteriaList            (PAI line 209)
 *   - CriteriaParseWarning         (PAI line 303)
 *   - diagnoseCriteria             (PAI line 309)
 *
 * Backward-compat preserved: legacy bracketed category tags
 * (`[F]/[S]/[B]/[N]/[E]/[A]`) from pre-v5.3.0 ISAs and `ISC-A-N` numbering
 * from v5.3.0–v5.4.0 ISAs. Documented in PAI lines 199-207, 244-246.
 */

// ── Heading detection (PAI lines 95-126) ──────────────────────────────────

/**
 * One canonical regex matching every historical Criteria heading variant:
 *   `## Criteria`
 *   `## ISC Criteria`
 *   `## IDEAL STATE CRITERIA (Verification Criteria)`
 *   `### Criteria` (sub-heading inside an IDEAL STATE block)
 * Case-insensitive. Section ends at the next `## ` (H2), `---`, or EOF.
 *
 * Verbatim from PAI line 108.
 */
export const CRITERIA_HEADING_RE: RegExp =
  /^(?:##\s+(?:ISC\s+)?Criteria\b[^\n]*|##\s+IDEAL\s+STATE\s+CRITERIA\b[^\n]*|###\s+Criteria\b[^\n]*)$/im

/** PAI line 113 — canonical heading new ISAs emit and migrations target. */
export const CANONICAL_CRITERIA_HEADING = "## ISC Criteria"

/**
 * Returns the criteria-section body (without the heading line), or null if no
 * recognized heading is found. Mirror of PAI line 118-127.
 */
export const extractCriteriaSection = (content: string): string | null => {
  const headingMatch = CRITERIA_HEADING_RE.exec(content)
  if (!headingMatch || headingMatch.index === undefined) return null
  const startOfBody = headingMatch.index + headingMatch[0].length
  const rest = content.slice(startOfBody)
  // End at the next H2 (`## ` but not `### `), a YAML doc terminator, or EOF.
  const endMatch = rest.match(/\n##\s+(?!#)|\n---\s*\n/)
  const body = endMatch ? rest.slice(0, endMatch.index) : rest
  return body
}

/** Mirror of PAI line 129-135. */
export const countCriteria = (
  content: string,
): { readonly checked: number; readonly total: number } => {
  const body = extractCriteriaSection(content)
  if (body === null) return { checked: 0, total: 0 }
  const lines = body.split("\n").filter((l) => l.match(/^- \[[ x]\]/))
  const checked = lines.filter((l) => l.startsWith("- [x]")).length
  return { checked, total: lines.length }
}

// ── Entry shape (PAI lines 184-197) ───────────────────────────────────────

export interface CriterionEntry {
  readonly id: string
  readonly description: string
  readonly type: "criterion" | "anti-criterion"
  readonly status: "pending" | "completed"
  readonly createdInPhase?: string
  /**
   * Legacy category code from pre-v5.3.0 ISAs ([F]/[S]/[B]/[N]/[E]/[A]).
   * Algorithm v5.3.0 dropped bracketed category tags; new ISAs leave this
   * `undefined`. Retained for backward-compat parsing of historical ISAs.
   */
  readonly category?: string
}

/**
 * Legacy category whitelist (PAI line 207). Used to distinguish real
 * pre-v5.3.0 category brackets (`[F]`) from ad-hoc status brackets
 * (`[COMPLETE]`, `[WIP]`) which we strip rather than capture.
 */
const VALID_CATEGORIES: ReadonlySet<string> = new Set([
  "F",
  "S",
  "B",
  "N",
  "E",
  "A",
])

// ── List parser (PAI lines 209-256) ───────────────────────────────────────

/**
 * Parse the criteria section into typed entries. Mirror of PAI line 209-256.
 *
 * Three regex shapes accepted, in order:
 *   1. Primary (v5.3.0+):     `- [x] ISC-1: description`
 *      With optional bracket: `- [x] ISC-1 [F]: description`
 *      With nested probe:     `- [x] ISC-1 [F][grep]: description`
 *   2. Loose fallback:        `- [x] ISC-1 description` (no colon)
 *      Strips any non-category bracket tokens from the loose-form text.
 *
 * Anti-criterion detection (PAI line 246):
 *   - `Anti:` prose prefix on description (v5.5.0+)
 *   - `id.includes('-A-')` (v5.3.0–v5.4.0 backward-compat)
 *
 * Domain-prefixed IDs like `ISC-CLI-3` are unaffected by the `-A-` check.
 */
export const parseCriteriaList = (content: string): ReadonlyArray<CriterionEntry> => {
  const body = extractCriteriaSection(content)
  if (body === null) return []
  const out: CriterionEntry[] = []
  for (const line of body.split("\n")) {
    if (!line.match(/^- \[[ x]\]/)) continue
    const checked = line.startsWith("- [x]")

    // Primary parse — bare ISC ID, `:` required.
    let textMatch: RegExpMatchArray | null = line.match(
      /^- \[[ x]\]\s*(ISC-[\w-]+)(?:\s+\[([A-Za-z]+)\](?:\[\w+\])?)?:\s*(.*)/,
    )

    // Fallback — no trailing `:`. Strip non-category brackets.
    if (!textMatch) {
      const loose = line.match(/^- \[[ x]\]\s*(ISC-[\w-]+)\s+(.*)/)
      if (loose && loose[1] !== undefined && loose[2] !== undefined) {
        const rest = loose[2].replace(/\[[A-Za-z]+\]\s*/g, "").trim()
        if (rest.length > 0) {
          textMatch = [line, loose[1], undefined as unknown as string, rest] as unknown as RegExpMatchArray
        }
      }
    }
    if (!textMatch || textMatch[1] === undefined || textMatch[3] === undefined) continue

    const id = textMatch[1]
    const rawCategory = textMatch[2]
    const category =
      typeof rawCategory === "string" && VALID_CATEGORIES.has(rawCategory.toUpperCase())
        ? rawCategory.toUpperCase()
        : undefined
    const description = textMatch[3].trim()
    const isAnti = /^Anti:\s/i.test(description) || id.includes("-A-")

    const entry: CriterionEntry = {
      id,
      description,
      type: isAnti ? "anti-criterion" : "criterion",
      status: checked ? "completed" : "pending",
      ...(category !== undefined ? { category } : {}),
    }
    out.push(entry)
  }
  return out
}

// ── Diagnose (PAI lines 295-317) ──────────────────────────────────────────

/**
 * Loud-fail signal for non-parseable ISAs (PAI line 303-307):
 *   'missing-section'   — no recognized Criteria heading at all
 *   'empty-section'     — heading present, zero `- [ ]` checkbox lines
 *   'all-dropped'       — checkbox lines present, ALL failed regex parse
 *   null                — healthy
 */
export type CriteriaParseWarning =
  | "missing-section"
  | "empty-section"
  | "all-dropped"
  | null

/** Mirror of PAI line 309-317. */
export const diagnoseCriteria = (content: string): CriteriaParseWarning => {
  const body = extractCriteriaSection(content)
  if (body === null) return "missing-section"
  const checkboxLines = body.split("\n").filter((l) => l.match(/^- \[[ x]\]/))
  if (checkboxLines.length === 0) return "empty-section"
  const parsed = parseCriteriaList(content)
  if (parsed.length === 0) return "all-dropped"
  return null
}
