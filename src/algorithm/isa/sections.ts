/**
 * 12-section walker for ISA v2.7 / Algorithm v6.2.0+.
 *
 * NEW DESIGN (this package — not a port). the upstream spec's `hooks/lib/isa-utils.ts`
 * parses only the Criteria section and ad-hoc Intent/Context/Problem Space
 * snippets. The 12-section walker is called out as a forthcoming patch in
 * `the upstream spec` line 213:
 *
 *   "(v6.2.x: the per-section schema may be pulled into this file directly
 *    when there's a need for a hook-readable single source of truth.)"
 *
 * The doctrine sections are listed in IsaFormat.md lines 174-187, fixed
 * order, empty sections never present (Bitter Pill discipline). Order is
 * load-bearing — the tier completeness gate enforces presence by name AND
 * the parser surfaces a dictionary keyed by canonical section name so the
 * gate doesn't have to know about heading variants.
 *
 * Heading detection rules:
 *   - Match H2 only (`## Section Name`).
 *   - Case-insensitive on the canonical name.
 *   - Trailing parenthesized qualifier allowed (mirror of Criteria heading
 *     tolerance, e.g. `## Out of Scope (anti-vision)`).
 *   - Section body ends at the next H2 or YAML doc terminator (`---`).
 *
 * Sections that do not appear in the source are simply absent from the
 * returned map. Empty sections (heading present but body all-whitespace)
 * are returned with `body: ""`.
 */

/**
 * The canonical section names from IsaFormat.md lines 176-187, in fixed
 * order. Exported as a tuple so the completeness gate can iterate without
 * re-declaring names.
 */
export const ISA_SECTIONS_V2_7 = [
  "Problem",
  "Vision",
  "Out of Scope",
  "Principles",
  "Constraints",
  "Goal",
  "Criteria",
  "Test Strategy",
  "Features",
  "Decisions",
  "Changelog",
  "Verification",
] as const

export type IsaSectionName = (typeof ISA_SECTIONS_V2_7)[number]

export interface IsaSection {
  /** Canonical section name (one of ISA_SECTIONS_V2_7). */
  readonly name: IsaSectionName
  /** Body text — everything after the heading line until the next H2 / YAML terminator / EOF. */
  readonly body: string
  /** Original heading line as it appeared (may include parenthesized qualifier). */
  readonly rawHeading: string
}

/**
 * Build the per-section heading regex. Matches `## ${name}` optionally
 * followed by `(qualifier)` and trailing whitespace, on its own line.
 * Case-insensitive on the name.
 *
 * The Criteria section is special — `criteria.ts` already owns its
 * heading-variant regex (CRITERIA_HEADING_RE which also matches
 * `## ISC Criteria` and `## IDEAL STATE CRITERIA`). For consistency, we
 * accept those variants here too via a one-shot lookup.
 */
const headingRegexFor = (name: IsaSectionName): RegExp => {
  if (name === "Criteria") {
    return /^(?:##\s+(?:ISC\s+)?Criteria\b[^\n]*|##\s+IDEAL\s+STATE\s+CRITERIA\b[^\n]*)$/im
  }
  // Escape regex metachars in the name (none of the v2.7 names need it,
  // but defensive against future additions).
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^##\\s+${escaped}\\b[^\\n]*$`, "im")
}

/**
 * Parse all 12 v2.7 sections out of an ISA body. Returns a map keyed by
 * canonical name. Sections not present in the source are absent from the
 * map (NOT present-with-empty-body). Frontmatter is stripped first if
 * present so leading `---\n…\n---` doesn't trip the section-end terminator.
 */
export const parseSections = (
  content: string,
): ReadonlyMap<IsaSectionName, IsaSection> => {
  const stripped = content.replace(/^---\n[\s\S]*?\n---\n?/, "")
  const out = new Map<IsaSectionName, IsaSection>()
  for (const name of ISA_SECTIONS_V2_7) {
    const re = headingRegexFor(name)
    const m = re.exec(stripped)
    if (!m || m.index === undefined) continue
    const headingLine = m[0]
    const startOfBody = m.index + headingLine.length
    const rest = stripped.slice(startOfBody)
    // End at next H2 (`## ` not `### `) or YAML doc terminator.
    const endMatch = rest.match(/\n##\s+(?!#)|\n---\s*\n/)
    const body = endMatch ? rest.slice(0, endMatch.index) : rest
    out.set(name, {
      name,
      body: body.replace(/^\n+/, "").replace(/\n+$/, ""),
      rawHeading: headingLine.trim(),
    })
  }
  return out
}

/** Convenience: which canonical sections are present in this ISA body. */
export const presentSections = (
  content: string,
): ReadonlySet<IsaSectionName> => new Set(parseSections(content).keys())
