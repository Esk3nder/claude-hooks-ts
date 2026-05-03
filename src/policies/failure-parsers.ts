/**
 * Failure parsers for PostToolUseFailure handler.
 * Each parser inspects raw error text and, if it matches, returns a structured summary.
 */

export type FailureCategory =
  | "pytest"
  | "jest"
  | "vitest"
  | "cargo"
  | "go-test"
  | "eslint"
  | "tsc"
  | "generic"

export interface ParsedFailure {
  readonly category: FailureCategory
  readonly topLines: ReadonlyArray<string>
  readonly likelyPath: string | null
}

const PATH_LINE_COL = /([\/.\w-]+\.[a-zA-Z]+):(\d+)(?::(\d+))?/

const findLikelyPath = (lines: ReadonlyArray<string>): string | null => {
  for (const line of lines) {
    const m = line.match(PATH_LINE_COL)
    if (m && m[0]) return m[0]
  }
  // fall back: bare path with extension
  for (const line of lines) {
    const m = line.match(/([\/.\w-]+\.[a-zA-Z]+)/)
    if (m && m[1]) return m[1]
  }
  return null
}

const splitLines = (s: string): string[] =>
  s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)

const top3 = (lines: string[]): string[] => lines.slice(0, 3)

const matchPytest = (text: string): ParsedFailure | null => {
  if (!/FAILED\s+\S+::/.test(text) && !/^E\s+/m.test(text)) return null
  const lines = splitLines(text).filter(
    (l) => /^E\s+/.test(l) || /FAILED\s+/.test(l) || /assert/i.test(l),
  )
  return {
    category: "pytest",
    topLines: top3(lines.length > 0 ? lines : splitLines(text)),
    likelyPath: findLikelyPath(splitLines(text)),
  }
}

const matchJest = (text: string): ParsedFailure | null => {
  if (/--- FAIL:/.test(text)) return null
  if (!/^\s*✕\s+/m.test(text) && !/\bFAIL\s+\S+\.(test|spec)\.[jt]sx?\b/.test(text) && !/\bJest\b/.test(text))
    return null
  // exclude vitest-style markers
  if (/\bVitest\b|⎯\s*Failed Tests/.test(text)) return null
  const lines = splitLines(text).filter(
    (l) => /^✕/.test(l) || /^FAIL\s+/.test(l) || /Expected/.test(l) || /Received/.test(l),
  )
  return {
    category: "jest",
    topLines: top3(lines.length > 0 ? lines : splitLines(text)),
    likelyPath: findLikelyPath(splitLines(text)),
  }
}

const matchVitest = (text: string): ParsedFailure | null => {
  if (!/\bVitest\b|⎯\s*Failed Tests/.test(text)) {
    return null
  }
  const lines = splitLines(text).filter(
    (l) => /✕|FAIL|Error:|Expected|Received/.test(l),
  )
  return {
    category: "vitest",
    topLines: top3(lines.length > 0 ? lines : splitLines(text)),
    likelyPath: findLikelyPath(splitLines(text)),
  }
}

const matchCargo = (text: string): ParsedFailure | null => {
  if (!/error\[E\d+\]|^error:/m.test(text) || !/-->/.test(text)) return null
  const lines = splitLines(text).filter(
    (l) => /^error/.test(l) || /-->/.test(l),
  )
  return {
    category: "cargo",
    topLines: top3(lines.length > 0 ? lines : splitLines(text)),
    likelyPath: findLikelyPath(splitLines(text)),
  }
}

const matchGoTest = (text: string): ParsedFailure | null => {
  if (!/--- FAIL:/.test(text)) return null
  const lines = splitLines(text).filter(
    (l) => /--- FAIL:/.test(l) || /\.go:\d+/.test(l),
  )
  return {
    category: "go-test",
    topLines: top3(lines.length > 0 ? lines : splitLines(text)),
    likelyPath: findLikelyPath(splitLines(text)),
  }
}

const matchEslint = (text: string): ParsedFailure | null => {
  // eslint: "  12:5  error  Unexpected ...  no-console"
  if (!/\s+error\s+.*\s+[a-z][a-z0-9-]+\/?[a-z0-9-]*\s*$/m.test(text)) return null
  const lines = splitLines(text).filter((l) => /\serror\s/.test(l))
  return {
    category: "eslint",
    topLines: top3(lines.length > 0 ? lines : splitLines(text)),
    likelyPath: findLikelyPath(splitLines(text)),
  }
}

const matchTsc = (text: string): ParsedFailure | null => {
  if (!/error TS\d+/.test(text)) return null
  const lines = splitLines(text).filter((l) => /error TS\d+/.test(l))
  return {
    category: "tsc",
    topLines: top3(lines.length > 0 ? lines : splitLines(text)),
    likelyPath: findLikelyPath(splitLines(text)),
  }
}

const matchGeneric = (text: string): ParsedFailure => {
  const lines = splitLines(text)
  return {
    category: "generic",
    topLines: top3(lines),
    likelyPath: findLikelyPath(lines),
  }
}

const PARSERS: ReadonlyArray<(t: string) => ParsedFailure | null> = [
  matchPytest,
  matchVitest,
  matchJest,
  matchCargo,
  matchGoTest,
  matchTsc,
  matchEslint,
]

export const parseFailure = (raw: string): ParsedFailure => {
  for (const p of PARSERS) {
    const r = p(raw)
    if (r !== null) return r
  }
  return matchGeneric(raw)
}
