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

const normalizeUrlMatch = (url: string): string =>
  url.replace(/[.,;:!?}\]]+$/g, "")

const uniqueUrlsFromText = (text: string): ReadonlyArray<string> => {
  const matches = text.match(URL_RE)
  if (!matches) return []
  return Array.from(
    new Set(
      matches
        .map(normalizeUrlMatch)
        .filter((url) => url.length > "https://".length),
    ),
  )
}

export const isVerificationCommand = (cmd: string): boolean =>
  VERIFY_COMMAND_PATTERNS.some((pattern) => pattern.test(cmd))

export const isSourceCollectionTool = (toolName: string): boolean =>
  SOURCE_COLLECTION_TOOLS.has(toolName)

export const urlsFromToolInput = (input: unknown): ReadonlyArray<string> => {
  if (typeof input !== "object" || input === null) return []
  const obj = input as { url?: unknown }
  const out: string[] = []
  if (typeof obj.url === "string") {
    const url = normalizeUrlMatch(obj.url)
    if (url.length > "https://".length) out.push(url)
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
  return uniqueUrlsFromText(text)
}

export const isSuccessfulToolResponse = (response: unknown): boolean => {
  if (response === undefined || response === null) return true
  if (typeof response !== "object") return true
  const obj = response as {
    readonly success?: unknown
    readonly error?: unknown
    readonly exitCode?: unknown
    readonly exit_code?: unknown
    readonly is_error?: unknown
    readonly isError?: unknown
    readonly interrupted?: unknown
    readonly timedOut?: unknown
    readonly timed_out?: unknown
    readonly status?: unknown
    readonly statusCode?: unknown
    readonly status_code?: unknown
  }
  if (obj.success === false) return false
  if (obj.is_error === true || obj.isError === true) return false
  if (obj.interrupted === true) return false
  if (obj.timedOut === true || obj.timed_out === true) return false
  if (obj.error !== undefined && obj.error !== null) return false
  if (typeof obj.exitCode === "number" && obj.exitCode !== 0) return false
  if (typeof obj.exit_code === "number" && obj.exit_code !== 0) return false
  for (const status of [obj.status, obj.statusCode, obj.status_code]) {
    if (typeof status === "number" && status >= 400) return false
    if (typeof status === "string" && /^[45]\d\d\b/.test(status.trim())) {
      return false
    }
  }
  return true
}

const RESPONSE_METADATA_KEYS: ReadonlySet<string> = new Set([
  "success",
  "ok",
  "exitCode",
  "exit_code",
  "status",
  "statusCode",
  "status_code",
  "timedOut",
  "timed_out",
])

const hasMeaningfulSourcePayload = (value: unknown): boolean => {
  if (typeof value === "string") return value.trim().length > 0
  if (Array.isArray(value)) return value.some(hasMeaningfulSourcePayload)
  if (typeof value !== "object" || value === null) return false
  for (const [key, nested] of Object.entries(value)) {
    if (RESPONSE_METADATA_KEYS.has(key)) continue
    if (hasMeaningfulSourcePayload(nested)) return true
  }
  return false
}

export const isUsableSourceToolResponse = (response: unknown): boolean => {
  if (!isSuccessfulToolResponse(response)) return false
  if (response === undefined || response === null) return false
  if (!hasMeaningfulSourcePayload(response)) return false
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
