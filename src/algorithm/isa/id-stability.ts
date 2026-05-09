/**
 * ID-stability validator for ISC IDs across an ISA edit.
 *
 * NEW DESIGN (this package — not a port). The doctrine rule lives in
 * `~/.claude/PAI/DOCUMENTATION/IsaFormat.md` line 207-209:
 *
 *   "ID-Stability Rule (NEW v2.7): ISC IDs never re-number on edit. Splits
 *    become `ISC-N.M` (parent preserved); drops become tombstones
 *    (`- [ ] ISC-N: [DROPPED — see Decisions]`). Reconcile depends on this;
 *    renumbering breaks ephemeral feature reconciliation silently."
 *
 * PAI states the rule but does not ship a hook-side validator for it. This
 * module is the doctrinal-rule-as-code: given an ISA's criteria before and
 * after an edit, return the set of IDs that were illegally renumbered.
 *
 * Three legal transitions (no violation):
 *   1. unchanged             — same ID, same description (or any change to text)
 *   2. split (ISC-N → ISC-N.M)   — parent preserved or replaced by children
 *   3. dropped (tombstoned)  — `- [ ] ISC-N: [DROPPED — see Decisions]`
 *
 * One illegal transition:
 *   - rename (ISC-N → ISC-K where K != N AND K is not N.<something>)
 *
 * Detection algorithm:
 *   1. Index befores by id and by descriptionHash.
 *   2. For each before-id that is NOT in afters and NOT tombstoned in afters
 *      and NOT a parent-of-any-after-N.M ID, look for an after-id whose
 *      description hash matches a before description that ALSO has a different
 *      id. Such a (beforeId → afterId) pair is a rename violation.
 *   3. Tombstone form is detected by description matching `^[DROPPED\b`.
 *
 * The validator works on parsed CriterionEntry arrays (from criteria.ts) so
 * heading-variant tolerance and bracket compat are inherited for free.
 */

import type { CriterionEntry } from "./criteria.ts"

export interface IdStabilityViolation {
  readonly kind: "renumbered"
  readonly beforeId: string
  readonly afterId: string
  /** First 80 chars of the description we matched on, for debug context. */
  readonly descriptionExcerpt: string
}

export interface IdStabilityReport {
  readonly ok: boolean
  readonly violations: ReadonlyArray<IdStabilityViolation>
  /** IDs that disappeared without a tombstone or a child split — flagged for diagnostic, not a violation per se. */
  readonly orphanedIds: ReadonlyArray<string>
}

const TOMBSTONE_PREFIX = /^\[DROPPED\b/i

/**
 * Strip "Anti: " / "Antecedent: " prose prefix and any embedded ISC-id
 * substrings before hashing so a description that names ISC-7 doesn't
 * accidentally match a different criterion that also names it.
 */
const normalizeDescription = (description: string): string =>
  description
    // Trim FIRST so leading whitespace doesn't defeat the `^` anchor in the
    // prefix strip (an Anti: criterion read from a markdown bullet often has
    // surrounding whitespace from the parser).
    .trim()
    .replace(/^(Anti|Antecedent):\s*/i, "")
    .replace(/\bISC-[\w.-]+\b/g, "<ISC>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()

const isTombstoned = (e: CriterionEntry): boolean =>
  TOMBSTONE_PREFIX.test(e.description.trim())

/**
 * True when `afterId` is a descendant of `beforeId` per the split convention
 * (`ISC-7` → `ISC-7.1`, `ISC-7` → `ISC-7.1.2`, etc.). Domain-prefixed IDs
 * (ISC-CLI-3) and legacy ISC-A-N are treated structurally — a parent
 * `ISC-CLI-3` matches `ISC-CLI-3.1`.
 */
const isDescendantOf = (afterId: string, beforeId: string): boolean =>
  afterId === beforeId ||
  afterId.startsWith(`${beforeId}.`)

export const validateIdStability = (
  before: ReadonlyArray<CriterionEntry>,
  after: ReadonlyArray<CriterionEntry>,
): IdStabilityReport => {
  const violations: IdStabilityViolation[] = []
  const orphans: string[] = []

  const afterById = new Map<string, CriterionEntry>()
  for (const e of after) afterById.set(e.id, e)

  // Build a multimap of normalized-description → after entries, used to
  // catch renumberings (same text, different id).
  const afterByDesc = new Map<string, CriterionEntry[]>()
  for (const e of after) {
    const key = normalizeDescription(e.description)
    if (key.length === 0) continue
    const list = afterByDesc.get(key) ?? []
    list.push(e)
    afterByDesc.set(key, list)
  }

  for (const b of before) {
    // Still present under same id → unchanged or text-edit. Fine.
    if (afterById.has(b.id)) continue

    // Has a tombstone under same id (description starts with [DROPPED).
    // findById already failed, so check whether there's an after-entry whose
    // id equals b.id AND is tombstoned. (A tombstone keeps the id, so this
    // case is already covered by afterById.has(b.id) above. Kept as a guard
    // in case future tombstone forms decouple id from description.)
    const tombstoned = after.find((a) => a.id === b.id && isTombstoned(a))
    if (tombstoned) continue

    // Has at least one descendant id (split: ISC-N → ISC-N.1, ISC-N.2). Fine.
    const hasChildSplit = after.some(
      (a) => a.id !== b.id && isDescendantOf(a.id, b.id),
    )
    if (hasChildSplit) continue

    // Rename detection: same description text now lives under a different id.
    const key = normalizeDescription(b.description)
    const candidates = afterByDesc.get(key) ?? []
    const renamed = candidates.find(
      (a) => a.id !== b.id && !isDescendantOf(a.id, b.id),
    )
    if (renamed !== undefined) {
      violations.push({
        kind: "renumbered",
        beforeId: b.id,
        afterId: renamed.id,
        descriptionExcerpt: b.description.slice(0, 80),
      })
      continue
    }

    // Disappeared without tombstone, split, or rename match. Diagnostic only.
    orphans.push(b.id)
  }

  return {
    ok: violations.length === 0,
    violations,
    orphanedIds: orphans,
  }
}
