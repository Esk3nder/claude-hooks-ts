import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs"
import { isaHandoffSection } from "../algorithm/isa/lifecycle.ts"
import { parseCriteriaList } from "../algorithm/isa/criteria.ts"

const MAX_TRANSCRIPT_SCAN_BYTES = 128 * 1024

export type ContextBudgetVerdict =
  | { readonly _tag: "ok" }
  | { readonly _tag: "block"; readonly reason: string }

export interface ContextBudgetInput {
  readonly contextPercent: number | null | undefined
  readonly threshold: number
  readonly isa: string | null | undefined
}

const OK: ContextBudgetVerdict = { _tag: "ok" }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const normalizePercentNumber = (value: number): number | null => {
  if (!Number.isFinite(value) || value < 0) return null
  return value <= 100 ? value : null
}

const percentFromUnknown = (value: unknown): number | null => {
  if (typeof value === "number") return normalizePercentNumber(value)
  if (typeof value !== "string") return null

  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  const parsed = Number(trimmed.endsWith("%") ? trimmed.slice(0, -1) : trimmed)
  return normalizePercentNumber(parsed)
}

const normalizedKey = (key: string): string =>
  key.toLowerCase().replace(/[^a-z]/g, "")

const keyLooksLikeContextPercent = (
  key: string,
  insideContextObject: boolean,
): boolean => {
  const normalized = normalizedKey(key)
  if (normalized.length === 0) return false
  if (
    normalized.includes("context") &&
    (normalized.includes("percent") || normalized.endsWith("pct"))
  ) {
    return true
  }
  return (
    insideContextObject &&
    (normalized === "percent" ||
      normalized === "pct" ||
      normalized === "usagepercent" ||
      normalized === "usedpercent")
  )
}

const findContextPercent = (
  value: unknown,
  depth = 0,
  insideContextObject = false,
): number | null => {
  if (depth > 4) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findContextPercent(item, depth + 1, insideContextObject)
      if (found !== null) return found
    }
    return null
  }
  if (!isRecord(value)) return null

  for (const [key, candidate] of Object.entries(value)) {
    if (!keyLooksLikeContextPercent(key, insideContextObject)) continue
    const percent = percentFromUnknown(candidate)
    if (percent !== null) return percent
  }

  for (const [key, candidate] of Object.entries(value)) {
    if (!isRecord(candidate) && !Array.isArray(candidate)) continue
    const found = findContextPercent(
      candidate,
      depth + 1,
      insideContextObject || normalizedKey(key).includes("context"),
    )
    if (found !== null) return found
  }

  return null
}

export const contextPercentFromPayload = (payload: unknown): number | null =>
  findContextPercent(payload)

const readTranscriptTail = (transcriptPath: string): string => {
  if (!existsSync(transcriptPath)) return ""
  const fd = openSync(transcriptPath, "r")
  try {
    const stat = fstatSync(fd)
    const length = Math.min(stat.size, MAX_TRANSCRIPT_SCAN_BYTES)
    if (length <= 0) return ""
    const start = Math.max(0, stat.size - length)
    const buffer = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, start + offset)
      if (read === 0) break
      offset += read
    }
    let text = buffer.subarray(0, offset).toString("utf8")
    if (start > 0) {
      const firstNewline = text.indexOf("\n")
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1)
    }
    return text
  } finally {
    closeSync(fd)
  }
}

export const contextPercentFromTranscript = (
  transcriptPath: string | undefined,
): number | null => {
  if (transcriptPath === undefined || transcriptPath.length === 0) return null
  try {
    const lines = readTranscriptTail(transcriptPath).trim().split("\n").reverse()
    for (const line of lines) {
      if (line.trim().length === 0) continue
      try {
        const parsed = JSON.parse(line) as unknown
        const percent = findContextPercent(parsed)
        if (percent !== null) return percent
      } catch {
        // Ignore malformed transcript lines; the gate is best-effort.
      }
    }
  } catch {
    return null
  }
  return null
}

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const lineText = (line: string): string =>
  line
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .trim()

const PLACEHOLDER_LINE_RE =
  /^(?:todo|tbd|none|n\/a|na|placeholder|pending|fill\s+this\s+in|add\s+handoff|handoff\s+goes\s+here|\.{3}|-+)$/i

const meaningfulHandoffLines = (body: string): ReadonlyArray<string> =>
  body
    .split(/\r?\n/)
    .map(lineText)
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith("<!--") &&
        !PLACEHOLDER_LINE_RE.test(line),
    )

const isLinked = (text: string, iscId: string): boolean => {
  const re = new RegExp(
    `(^|[^A-Za-z0-9_-])${escapeRegExp(iscId)}(?=$|[^A-Za-z0-9_-])`,
  )
  return re.test(text)
}

const hasRecoverableHandoff = (isa: string): boolean => {
  const handoff = isaHandoffSection(isa)
  if (handoff === null) return false

  const lines = meaningfulHandoffLines(handoff.body)
  if (lines.length === 0) return false

  const text = lines.join("\n")
  const iscIds = [...new Set(parseCriteriaList(isa).map((entry) => entry.id))]
  if (iscIds.length === 0) return false

  return iscIds.every((id) => isLinked(text, id))
}

const formatPercent = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(1)

export const evaluateBudget = (
  input: ContextBudgetInput,
): ContextBudgetVerdict => {
  if (input.threshold <= 0) return OK

  const contextPercent = normalizePercentNumber(input.contextPercent ?? NaN)
  if (contextPercent === null) return OK
  if (contextPercent < input.threshold) return OK
  if (typeof input.isa === "string" && hasRecoverableHandoff(input.isa)) {
    return OK
  }

  return {
    _tag: "block",
    reason:
      `Context usage is ${formatPercent(contextPercent)}% ` +
      `(threshold ${formatPercent(input.threshold)}%). Add a populated ` +
      "`## Handoff` section to the active ISA with at least one " +
      `non-placeholder line that links to every active ISC before stopping.`,
  }
}
