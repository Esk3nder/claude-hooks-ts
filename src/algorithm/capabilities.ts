/**
 * Closed enumeration of THINKING capabilities + phantom-audit validator.
 *
 * Verbatim port of PAI's Algorithm v6.3.0 closed-enum doctrine (the bullet
 * list at `~/.claude/PAI/ALGORITHM/v6.3.0.md` lines 41-62) and capabilities
 * reference (`~/.claude/PAI/ALGORITHM/capabilities.md`).
 *
 * From v6.3.0 doctrine:
 *   "The thinking-capability vocabulary is a CLOSED ENUMERATION. Selection
 *    MUST come verbatim from this list — the same names that appear in
 *    capabilities.md § Thinking & Analysis Capabilities. Inventing generic
 *    labels (...) is a PHANTOM thinking capability and counts as a CRITICAL
 *    FAILURE — it does NOT contribute to the tier floor regardless of how
 *    the rest of the response is written."
 *
 * Audit-gate rule (v6.3.0 line 65):
 *   "Capability-Name Audit Gate (NEW v6.3.0, fires at OBSERVE→THINK
 *    boundary): before printing 🏹 CAPABILITIES SELECTED, verify each
 *    thinking name appears verbatim in the closed list above. Any miss is
 *    a phantom — split, replace from the list, or remove."
 *
 * Wiring note (HONEST disclosure): PAI's audit is MODEL-side. The model
 * prints `🏹 CAPABILITIES SELECTED` in its response text; hooks cannot
 * intercept text output. This module exposes the validator as a pure
 * function so any caller (a future ISA `## Decisions` parser, an in-process
 * skill, ad-hoc tooling, the Stop gate) can apply the rule. We do NOT wire
 * it into a hook this slice — model-side use mirrors PAI behavior.
 */

/**
 * The 19-name closed enumeration. Order matches Algorithm v6.3.0 doctrine
 * lines 43-62 (and is meaningful: it groups thinking capabilities by the
 * doctrinal phase they typically support — OBSERVE/THINK first, VERIFY
 * last).
 *
 * Editing this list requires:
 *   1. A corresponding edit to PAI Algorithm doctrine.
 *   2. A version bump (PAI's doctrine is currently v6.3.0).
 *   3. The pin tests in `capabilities.test.ts` will fail until updated.
 */
export const THINKING_CAPABILITIES: ReadonlyArray<string> = [
  "IterativeDepth",
  "ApertureOscillation",
  "FeedbackMemoryConsult",
  "Advisor",
  "ReReadCheck",
  "FirstPrinciples",
  "SystemsThinking",
  "RootCauseAnalysis",
  "Council",
  "RedTeam",
  "Science",
  "BeCreative",
  "Ideate",
  "BitterPillEngineering",
  "Evals",
  "WorldThreatModel",
  "Fabric patterns",
  "ContextSearch",
  "ISA",
] as const

/** O(1) membership lookup for `auditCapabilityNames`. */
const THINKING_SET: ReadonlySet<string> = new Set(THINKING_CAPABILITIES)

export interface PhantomAuditReport {
  /** True iff every selected name appears verbatim in THINKING_CAPABILITIES. */
  readonly ok: boolean
  /** Names selected that are NOT in the closed list (case-sensitive, exact match). */
  readonly phantoms: ReadonlyArray<string>
  /** Names selected that ARE in the closed list (subset of input). */
  readonly valid: ReadonlyArray<string>
  /**
   * One-line guidance for the caller to surface to the model. Empty when
   * `ok` is true.
   */
  readonly message: string
}

/**
 * Pure phantom-audit validator. Verbatim case-sensitive match against
 * `THINKING_CAPABILITIES`. The doctrine explicitly says "the literal
 * closed-list name (bold), not a paraphrase" — so trimming/lowercasing
 * inputs before the check would defeat the purpose.
 *
 * Caller decides enforcement (warn / block / ignore). Returns a structured
 * report rather than throwing.
 */
export const auditCapabilityNames = (
  selected: ReadonlyArray<string>,
): PhantomAuditReport => {
  const phantoms: string[] = []
  const valid: string[] = []
  for (const name of selected) {
    if (typeof name !== "string") continue
    if (THINKING_SET.has(name)) valid.push(name)
    else phantoms.push(name)
  }
  if (phantoms.length === 0) {
    return { ok: true, phantoms, valid, message: "" }
  }
  const list = phantoms.map((p) => `"${p}"`).join(", ")
  return {
    ok: false,
    phantoms,
    valid,
    message:
      `Phantom thinking capabilities: ${list}. ` +
      `Replace each with a verbatim name from the closed list ` +
      `(see THINKING_CAPABILITIES) or split/remove it. ` +
      `Algorithm v6.3.0 line 65: phantoms do NOT contribute to the tier floor.`,
  }
}

/**
 * Convenience: extract `🏹` capability lines from a model's response or ISA
 * Decisions section. Doctrine output form is `🏹 **Name** → PHASE | reason`.
 * We pull the bolded name (between `**` markers) when present, falling back
 * to the first whitespace-delimited token after the bow emoji.
 *
 * Returns the list of names found, in source order. Caller pipes into
 * `auditCapabilityNames`.
 */
export const extractCapabilityNames = (text: string): ReadonlyArray<string> => {
  const out: string[] = []
  const lines = text.split("\n")
  for (const line of lines) {
    if (!line.includes("🏹")) continue
    // Skip the doctrinal header line itself.
    if (/CAPABILIT(?:IES|Y)\s*SELECTED/i.test(line)) continue
    // Bold form: `🏹 **Name** ...`
    const bold = line.match(/🏹\s*\*\*([^*]+)\*\*/)
    if (bold && bold[1] !== undefined) {
      out.push(bold[1].trim())
      continue
    }
    // Fallback: first non-empty token after the emoji.
    const fallback = line.match(/🏹\s*([A-Za-z][\w ]*?)(?:\s*[|→]|\s*$)/)
    if (fallback && fallback[1] !== undefined) {
      out.push(fallback[1].trim())
    }
  }
  return out
}
