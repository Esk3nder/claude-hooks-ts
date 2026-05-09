/**
 * Content-scan policy — scans tool RESPONSES for secret/PII patterns and
 * surfaces a structured finding the PostToolUse handler can either log,
 * append to additionalContext, or use to block downstream behavior.
 *
 * Composes with `services/redact.ts` (which owns pattern definitions and
 * O(1) detection). This module is the policy seam: it decides what kinds
 * of payloads are worth scanning, slices large outputs for performance,
 * and shapes findings into a return type the handler can branch on.
 *
 * Pure module — no I/O, no Effect dependency. Caller (the handler) does
 * the side effects (additionalContext emit, log).
 *
 * Default behavior is REPORT-ONLY. The handler logs findings to stderr
 * and emits a structured `additionalContext` line so the model sees the
 * warning. Blocking is opt-in via the `blockOnSecret` flag — wired off by
 * default to avoid surprise breakage.
 */

const MAX_SCAN_BYTES = 64 * 1024

export interface ContentScanFinding {
  /** What payload field was scanned. Diagnostic only. */
  readonly field: "tool_response" | "tool_input"
  /** Always true at the policy layer — caller decides what to do. */
  readonly secretDetected: boolean
  /** Length of the scanned input in bytes (after slice cap). */
  readonly scannedBytes: number
  /** True iff the scan was truncated due to MAX_SCAN_BYTES. */
  readonly truncated: boolean
  /** Diagnostic message suitable for stderr / additionalContext. */
  readonly message: string
}

/**
 * Coerce a payload field of unknown shape into a string we can scan.
 * Tool responses can be string, object (JSON-serialized), or undefined.
 * We stringify objects via JSON.stringify so structured outputs that
 * embed a secret still trigger the scan.
 */
export const coerceForScan = (value: unknown): string => {
  if (typeof value === "string") return value
  if (value === undefined || value === null) return ""
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return ""
  }
}

/**
 * Slice the payload at MAX_SCAN_BYTES so a 100MB JSON blob doesn't
 * regex-pin the dispatcher's 4s budget. Returns both the slice AND a
 * truncated flag so callers can warn when a scan was incomplete.
 */
export const sliceForScan = (
  raw: string,
): { readonly text: string; readonly truncated: boolean } => {
  if (raw.length <= MAX_SCAN_BYTES) return { text: raw, truncated: false }
  return { text: raw.slice(0, MAX_SCAN_BYTES), truncated: true }
}

/**
 * Build a finding given a containsSecret detector result. Pure — caller
 * supplies the detection by calling `Redact.containsSecret(text)`.
 */
export const buildFinding = (input: {
  readonly field: ContentScanFinding["field"]
  readonly text: string
  readonly truncated: boolean
  readonly secretDetected: boolean
}): ContentScanFinding => {
  const { field, text, truncated, secretDetected } = input
  const baseMsg = secretDetected
    ? `[content-scan] secret pattern detected in ${field} (scanned ${text.length}B${truncated ? ", truncated" : ""})`
    : `[content-scan] no secret detected in ${field} (scanned ${text.length}B${truncated ? ", truncated" : ""})`
  return {
    field,
    secretDetected,
    scannedBytes: text.length,
    truncated,
    message: baseMsg,
  }
}

/**
 * Scan a tool payload (response or input) using a synchronous detector
 * function. Returns the finding. Caller wires the `detect` function from
 * the Redact service.
 */
export const scanContent = (
  field: ContentScanFinding["field"],
  rawValue: unknown,
  detect: (text: string) => boolean,
): ContentScanFinding => {
  const text = coerceForScan(rawValue)
  if (text.length === 0) {
    return {
      field,
      secretDetected: false,
      scannedBytes: 0,
      truncated: false,
      message: `[content-scan] ${field} empty, skipped`,
    }
  }
  const sliced = sliceForScan(text)
  const secretDetected = detect(sliced.text)
  return buildFinding({
    field,
    text: sliced.text,
    truncated: sliced.truncated,
    secretDetected,
  })
}

/**
 * Render a structured warning line for additionalContext / stderr. Single
 * line, capped to 320 chars so multiple concurrent findings don't bloat
 * the model's context.
 */
export const renderWarning = (f: ContentScanFinding): string => {
  if (!f.secretDetected) return ""
  const truncMark = f.truncated ? " [scan truncated]" : ""
  const line = `WARNING: secret pattern detected in tool ${f.field} (${f.scannedBytes}B scanned${truncMark}). Treat output as sensitive — do NOT echo to user, write to logs, or commit verbatim.`
  return line.slice(0, 320)
}
