/**
 * US-14 — ISC checkbox probe-provenance.
 *
 * Distinguishes probe-flipped checkboxes from model-flipped ones at Stop
 * time. The PostToolUse probe-pass path appends the iscId to
 * `session-state.probe_verified_iscs`; the Stop completeness gate consults
 * this list against the ISA `## Test Strategy` `requires_probe` column.
 *
 * If a criterion is `completed` (checkbox flipped) AND marked
 * `requires_probe: true` in Test Strategy AND its id is absent from
 * `probe_verified_iscs`, the gate blocks — the checkbox was flipped by
 * the model directly (or some other path), not by a probe pass.
 *
 * Two pure functions:
 *   - parseProbeRequirements: ISA Test Strategy body → iscId → boolean
 *   - evaluateProbeProvenance: criteria + requirements + verified list
 *     → passthrough | block with named unverified ISCs
 *
 * No I/O. Caller (Stop handler) handles the actual block emission.
 */

import type { CriterionEntry } from "./criteria.ts"

// ──────────────────────────────────────────────────────────────────────
// Parser — extract `requires_probe` column from Test Strategy table
// ──────────────────────────────────────────────────────────────────────

const TRUTHY = new Set<string>(["true", "yes", "1"])
const FALSY = new Set<string>(["false", "no", "0"])

const parseBoolCell = (cell: string): boolean | null => {
  const norm = cell.trim().toLowerCase()
  if (TRUTHY.has(norm)) return true
  if (FALSY.has(norm)) return false
  return null
}

/**
 * Parse the ISA `## Test Strategy` body, returning a map from `ISC-...`
 * to its `requires_probe` boolean.
 *
 * The Test Strategy table is a markdown pipe table. We look for two columns:
 *   - A column whose header (case-insensitive) starts with `isc` — the id
 *   - A column whose header (case-insensitive) is exactly `requires_probe`
 *
 * Rows with malformed / missing / non-boolean cells in the requires_probe
 * column are omitted from the result (defaults to "not declared", which
 * the gate treats as "not required").
 */
export const parseProbeRequirements = (
  body: string,
): ReadonlyMap<string, boolean> => {
  const out = new Map<string, boolean>()
  const lines = body.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|"))
  if (lines.length === 0) return out

  // Locate the header row — first non-separator line.
  let headerIdx = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ""
    if (/^\|\s*[-:]+\s*\|/.test(line)) continue
    headerIdx = i
    break
  }
  if (headerIdx === -1) return out

  const headerLine = lines[headerIdx]
  if (headerLine === undefined) return out
  const headerCells = headerLine
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim().toLowerCase())
  const iscColIdx = headerCells.findIndex((h) => h === "isc" || h.startsWith("isc"))
  const reqColIdx = headerCells.findIndex((h) => h === "requires_probe")
  if (iscColIdx === -1 || reqColIdx === -1) return out

  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ""
    if (/^\|\s*[-:]+\s*\|/.test(line)) continue
    const cells = line.split("|").slice(1, -1).map((c) => c.trim())
    const idCell = cells[iscColIdx]
    const reqCell = cells[reqColIdx]
    if (idCell === undefined || reqCell === undefined) continue
    const idMatch = idCell.match(/^(ISC-[\w.-]+)$/)
    if (idMatch === null || idMatch[1] === undefined) continue
    const bool = parseBoolCell(reqCell)
    if (bool === null) continue
    out.set(idMatch[1], bool)
  }
  return out
}

// ──────────────────────────────────────────────────────────────────────
// Gate — refuse completed-without-probe-provenance for required ISCs
// ──────────────────────────────────────────────────────────────────────

export interface ProbeProvenanceInput {
  readonly criteria: ReadonlyArray<CriterionEntry>
  readonly requirements: ReadonlyMap<string, boolean>
  readonly verifiedIscs: ReadonlyArray<string>
}

export type ProbeProvenanceVerdict =
  | { readonly kind: "passthrough" }
  | {
      readonly kind: "block"
      readonly reason: string
      readonly unverified: ReadonlyArray<string>
    }

export const evaluateProbeProvenance = (
  input: ProbeProvenanceInput,
): ProbeProvenanceVerdict => {
  const verified = new Set(input.verifiedIscs)
  const unverified: string[] = []
  for (const c of input.criteria) {
    if (c.status !== "completed") continue
    const required = input.requirements.get(c.id)
    if (required !== true) continue
    if (!verified.has(c.id)) unverified.push(c.id)
  }
  if (unverified.length === 0) return { kind: "passthrough" }
  const list = unverified.join(", ")
  return {
    kind: "block",
    reason:
      `ISC checkbox provenance failed: ${unverified.length} criterion ` +
      `${unverified.length === 1 ? "is" : "are"} marked ` +
      `requires_probe: true in Test Strategy but ` +
      `${unverified.length === 1 ? "was" : "were"} checked without a ` +
      `probe-pass record in this session. Unverified: ${list}. Run the ` +
      `matching probe and let the PostToolUse handler flip the checkbox, ` +
      `or downgrade requires_probe to false in Test Strategy.`,
    unverified,
  }
}
