/**
 * Detect and rewrite noisy test/build commands so output is failure-only.
 *
 * Used by PreToolUse policy: when a Bash command matches a known
 * test/build invocation and is not already piped/redirected, we wrap it to
 * pipe stderr+stdout through a grep that filters to lines around failures
 * plus a hard cap via head.
 */

export interface TestOutputRewriteResult {
  readonly rewritten: string
  readonly truncated: boolean
}

const TEST_PATTERNS: ReadonlyArray<RegExp> = [
  /\bnpm\s+(run\s+)?test\b/i,
  /\bpnpm\s+(run\s+)?test\b/i,
  /\byarn\s+(run\s+)?test\b/i,
  /\bbun\s+(run\s+)?test\b/i,
  /\bjest\b/i,
  /\bvitest\b/i,
  /\bpytest\b/i,
  /\bcargo\s+test\b/i,
  /\bgo\s+test\b/i,
  /\bmake\s+test\b/i,
  /\bnpm\s+run\s+build\b/i,
  /\bpnpm\s+(run\s+)?build\b/i,
  /\byarn\s+(run\s+)?build\b/i,
  /\bbun\s+run\s+build\b/i,
  /\btsc\b/i,
  /\beslint\b/i,
  /\bruff\b/i,
]

const FAILURE_FILTER =
  "2>&1 | grep -A 8 -E '(FAIL|ERROR|Error:|error\\[|✕|FAILED)' | head -200"

export const isTestLikeCommand = (cmd: string): boolean =>
  TEST_PATTERNS.some((p) => p.test(cmd))

export const hasPipeOrRedirect = (cmd: string): boolean => {
  // crude but sufficient: detect pipe to grep/head/tee or any > redirect
  if (/[|]\s*(grep|head|tee|less|more|awk|sed)\b/.test(cmd)) return true
  if (/(?:^|[^>])>(?!&)/.test(cmd)) return true // redirect to file (not 2>&1)
  if (/&>\s*\S+/.test(cmd)) return true
  return false
}

export const shouldRewrite = (cmd: string): boolean => {
  if (!isTestLikeCommand(cmd)) return false
  if (hasPipeOrRedirect(cmd)) return false
  return true
}

export const rewriteTestCommand = (cmd: string): string => {
  const trimmed = cmd.trim()
  return `${trimmed} ${FAILURE_FILTER}`
}

/**
 * Pure helper used by post-batch context governor for raw output strings
 * (kept compatible with prior M3 stub signature).
 */
export const rewriteTestOutput = (raw: string): TestOutputRewriteResult => {
  const lines = raw.split(/\r?\n/)
  const fail = /(FAIL|ERROR|Error:|error\[|✕|FAILED)/i
  const kept: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    if (fail.test(lines[i] ?? "")) {
      const start = Math.max(0, i - 1)
      const end = Math.min(lines.length, i + 9)
      for (let j = start; j < end; j += 1) {
        const ln = lines[j]
        if (ln !== undefined) kept.push(ln)
      }
    }
    if (kept.length >= 200) break
  }
  const truncated = kept.length > 0 && kept.length < lines.length
  return {
    rewritten: kept.length === 0 ? raw : kept.slice(0, 200).join("\n"),
    truncated,
  }
}
