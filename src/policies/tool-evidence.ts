const VERIFY_COMMAND_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:^|[;&|]{1,2})\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:test|typecheck|lint)\b/i,
  /(?:^|[;&|]{1,2})\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:pytest|vitest|jest|eslint|ruff)\b/i,
  /(?:^|[;&|]{1,2})\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*tsc\b/i,
  /(?:^|[;&|]{1,2})\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*node\s+--check\b/i,
  /(?:^|[;&|]{1,2})\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*cargo\s+test\b/i,
  /(?:^|[;&|]{1,2})\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*go\s+test\b/i,
  /(?:^|[;&|]{1,2})\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:make|just|task)\s+(?:test|typecheck|lint)\b/i,
]

const SOURCE_COLLECTION_TOOLS: ReadonlySet<string> = new Set([
  "WebFetch",
  "WebSearch",
  // UI/log aliases used by some Claude Code builds.
  "Fetch",
  "Web Search",
])

const URL_RE = /https?:\/\/[^\s"'<>)]+/g
const SOURCE_RESPONSE_FAILURE_RE =
  /\b(?:403 Forbidden|404 Not Found|500 Internal Server Error|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout|Received 0 bytes|timed out|request failed)\b/i

export const isVerificationCommand = (cmd: string): boolean =>
  VERIFY_COMMAND_PATTERNS.some((pattern) => pattern.test(cmd))

export const isSourceCollectionTool = (toolName: string): boolean =>
  SOURCE_COLLECTION_TOOLS.has(toolName)

export const urlsFromToolInput = (input: unknown): ReadonlyArray<string> => {
  if (typeof input !== "object" || input === null) return []
  const obj = input as { url?: unknown; query?: unknown }
  const out: string[] = []
  if (typeof obj.url === "string") out.push(obj.url)
  if (typeof obj.query === "string") {
    const matches = obj.query.match(URL_RE)
    if (matches) out.push(...matches)
  }
  return out
}

export const urlsFromToolResponse = (response: unknown): ReadonlyArray<string> => {
  if (response === undefined || response === null) return []
  let text = ""
  if (typeof response === "string") text = response
  else {
    try {
      text = JSON.stringify(response)
    } catch {
      return []
    }
  }
  const matches = text.match(URL_RE)
  return matches ? Array.from(new Set(matches)) : []
}

export const isSuccessfulToolResponse = (response: unknown): boolean => {
  if (response === undefined || response === null) return true
  if (typeof response !== "object") return true
  const obj = response as {
    readonly success?: unknown
    readonly error?: unknown
    readonly exitCode?: unknown
    readonly exit_code?: unknown
  }
  if (obj.success === false) return false
  if (obj.error !== undefined && obj.error !== null) return false
  if (typeof obj.exitCode === "number" && obj.exitCode !== 0) return false
  if (typeof obj.exit_code === "number" && obj.exit_code !== 0) return false
  return true
}

export const isUsableSourceToolResponse = (response: unknown): boolean => {
  if (!isSuccessfulToolResponse(response)) return false
  if (response === undefined || response === null) return false
  const text =
    typeof response === "string"
      ? response
      : (() => {
          try {
            return JSON.stringify(response)
          } catch {
            return ""
          }
        })()
  if (SOURCE_RESPONSE_FAILURE_RE.test(text)) return false
  return true
}
