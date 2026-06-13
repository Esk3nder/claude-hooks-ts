/**
 * Verify-map — declarative "when source files changed, run this verification
 * command at Stop" rules read from `<repo>/.claude-hooks/verify-map.yaml`.
 *
 * Unlike `regenerate.yaml` (best-effort doc regen, never blocks), verify-map
 * rules CAN block Stop. The Stop handler selects ONE rule per Stop (highest
 * priority, then most-specific source glob), runs the command, and updates
 * `verification_status` accordingly. Failure/timeout returns a block decision
 * with the command + captured output tail.
 *
 * **Trust boundary.** `verify-map.yaml` is treated as trusted user config —
 * the same boundary as `regenerate.yaml`, `package.json` scripts, and the
 * settings.json hook entries themselves. The Stop handler will exec whatever
 * command appears here, with the privileges of the Claude Code process,
 * inside the caller-provided working directory (the Stop handler passes the
 * frozen `session_root`). Do NOT commit a `verify-map.yaml` you wouldn't
 * trust to run at completion of every Stop. The Stop handler loads this file
 * from `<session_root>/.claude-hooks/verify-map.yaml`, unlike cwd-scoped
 * `regenerate.yaml`.
 *
 * YAML shape:
 *
 *   rules:
 *     - source: "src/algorithm/isa/*.ts"
 *       command: ["bun", "test", "test/algorithm/isa"]
 *       timeoutMs: 20000
 *       priority: 10
 *
 *     - source: "src/*.ts"
 *       command: bun run typecheck
 *       priority: 100
 *
 * - `source` is a `*`-only glob (no `**`, no character classes, no braces).
 * - `command` is either a shell string (run via `sh -c` — shell-interpreted)
 *   or a `[cmd, ...args]` argv array (preferred — no shell escaping concerns).
 * - `timeoutMs` defaults to {@link DEFAULT_VERIFY_TIMEOUT_MS}; capped at
 *   {@link MAX_VERIFY_TIMEOUT_MS}.
 * - `priority` defaults to {@link DEFAULT_VERIFY_PRIORITY}. LOWER wins.
 *
 * Selection is **one rule per Stop** — for repos that need multiple checks,
 * compose them into one wrapper script (e.g. `verify:changed`).
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { normalizePathPattern } from "./path-utils.ts"
import { runCommandLive, runShellCommandLive } from "../services/command-runner.ts"
import { logWarningSync } from "../services/diagnostics.ts"

const VERIFY_MAP_SUBPATH = [".claude-hooks", "verify-map.yaml"] as const
const VERIFY_MAP_REL = VERIFY_MAP_SUBPATH.join("/")
const VERIFY_MAP_TAIL = `/${VERIFY_MAP_REL}`

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "")

export const verifyMapPathFor = (root: string = process.cwd()): string =>
  join(root, ...VERIFY_MAP_SUBPATH)

/**
 * Does `filePath` point to the active hook `.claude-hooks/verify-map.yaml`
 * config? When `root` is supplied, only that root's config (or its
 * root-relative spelling) matches. Without a root, falls back to a
 * `.claude-hooks/verify-map.yaml` tail match. A bare `verify-map.yaml`
 * in an unrelated directory is intentionally NOT matched.
 */
export const isVerifyMapPath = (
  filePath: string,
  root?: string | null,
): boolean => {
  if (typeof filePath !== "string" || filePath.length === 0) return false
  const normalized = normalizePathPattern(filePath)
  if (typeof root === "string" && root.length > 0) {
    if (normalized === VERIFY_MAP_REL) return true
    const rootNormalized = trimTrailingSlash(normalizePathPattern(root))
    return normalized === `${rootNormalized}/${VERIFY_MAP_REL}`
  }
  return (
    normalized.endsWith(VERIFY_MAP_TAIL) ||
    normalized === VERIFY_MAP_REL
  )
}

export const DEFAULT_VERIFY_TIMEOUT_MS = 15_000
export const MAX_VERIFY_TIMEOUT_MS = 22_000
export const DEFAULT_VERIFY_PRIORITY = 100

export interface VerifyRule {
  readonly source: string
  readonly command: string | ReadonlyArray<string>
  readonly timeoutMs: number
  readonly priority: number
}

interface ParseSuccess {
  readonly _tag: "ok"
  readonly rules: ReadonlyArray<VerifyRule>
}
interface ParseFailure {
  readonly _tag: "fail"
  readonly message: string
}

const clampTimeout = (n: number): number => {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_VERIFY_TIMEOUT_MS
  return Math.min(Math.floor(n), MAX_VERIFY_TIMEOUT_MS)
}

const stripTrailingComment = (line: string): string => {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === "#" && !inSingle && !inDouble) {
      const prev = i > 0 ? line[i - 1] : ""
      if (prev === " " || prev === "\t") return line.slice(0, i - 1)
    }
  }
  return line
}

interface Draft {
  source?: string
  command?: string | string[]
  timeoutMs?: number
  priority?: number
}

interface CommandParseSuccess {
  readonly _tag: "ok"
  readonly command: string | string[]
}

interface CommandParseSkip {
  readonly _tag: "skip"
}

interface CommandParseFailure {
  readonly _tag: "fail"
  readonly message: string
}

const parseScalarNumber = (val: string): number | null => {
  const trimmed = val.trim()
  if (trimmed.length === 0) return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

const parseCommandValue = (
  val: string,
): CommandParseSuccess | CommandParseSkip | CommandParseFailure => {
  const trimmed = val.trim()
  if (trimmed.length === 0) return { _tag: "skip" }
  if (trimmed.startsWith("[")) {
    const looksLikeJsonArray =
      trimmed === "[]" ||
      trimmed.startsWith("[\"") ||
      trimmed.startsWith("['")
    if (!trimmed.endsWith("]")) {
      if (!looksLikeJsonArray) {
        return { _tag: "ok", command: trimmed.replace(/^["']|["']$/g, "") }
      }
      return { _tag: "fail", message: "command array is missing closing ]" }
    }
    try {
      const arr = JSON.parse(trimmed) as unknown
      if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) {
        return { _tag: "ok", command: arr as string[] }
      }
      return { _tag: "fail", message: "command array must contain only strings" }
    } catch (err) {
      if (!looksLikeJsonArray) {
        return { _tag: "ok", command: trimmed.replace(/^["']|["']$/g, "") }
      }
      return {
        _tag: "fail",
        message: `command array JSON parse failed: ${String(err).slice(0, 80)}`,
      }
    }
  }
  return { _tag: "ok", command: trimmed.replace(/^["']|["']$/g, "") }
}

const assignKey = (draft: Draft, key: string, val: string): string | null => {
  if (key === "source") {
    draft.source = val.replace(/^["']|["']$/g, "")
    return null
  }
  if (key === "command") {
    const c = parseCommandValue(val)
    if (c._tag === "fail") return c.message
    if (c._tag === "ok") draft.command = c.command
    return null
  }
  if (key === "timeoutMs" || key === "priority") {
    const n = parseScalarNumber(val)
    if (n !== null) draft[key] = n
  }
  return null
}

export const parseVerifyMapYaml = (raw: string): ParseSuccess | ParseFailure => {
  const lines = raw.split("\n")
  let inRules = false
  const rules: VerifyRule[] = []
  let current: Draft = {}

  const flush = (): void => {
    if (typeof current.source === "string" && current.command !== undefined) {
      rules.push({
        source: current.source,
        command: current.command,
        timeoutMs: clampTimeout(current.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS),
        priority: current.priority ?? DEFAULT_VERIFY_PRIORITY,
      })
    }
    current = {}
  }

  for (const rawLine of lines) {
    const line = stripTrailingComment(rawLine).trimEnd()
    if (line.length === 0) continue
    if (/^rules\s*:\s*$/.test(line)) {
      inRules = true
      continue
    }
    if (!inRules) continue
    const itemHeadMatch = line.match(/^\s*-\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
    if (itemHeadMatch && itemHeadMatch[1] !== undefined && itemHeadMatch[2] !== undefined) {
      flush()
      const failure = assignKey(current, itemHeadMatch[1], itemHeadMatch[2])
      if (failure !== null) return { _tag: "fail", message: failure }
      continue
    }
    const subMatch = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
    if (subMatch && subMatch[1] !== undefined && subMatch[2] !== undefined) {
      const failure = assignKey(current, subMatch[1], subMatch[2])
      if (failure !== null) return { _tag: "fail", message: failure }
    }
  }
  flush()

  return { _tag: "ok", rules }
}

/**
 * Compile a glob to a RegExp anchored start-to-end. EP P2 #9 — single
 * star is single-segment (no `/`); double star is multi-segment.
 *   single star  -> `[^/]*` — matches one path segment, no separators
 *   double star  -> `.*`    — matches any depth
 *
 * Other regex metacharacters are escaped. Pre-fix single star
 * compiled to `.*`, so `src` + star + `.ts` matched
 * `src/algorithm/isa/lifecycle.ts` (broader than the documented
 * semantic). The Opus diligence on 2026-05-20 flagged this as a
 * low-impact drift.
 *
 * Implementation: tokenize on double star first to capture the
 * recursive marker, then replace remaining single stars with
 * single-segment. The sentinel prevents the substitution result
 * from being re-processed by the single-star pass.
 */
const escapeRegex = (s: string): string =>
  s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")

const globToRegex = (glob: string): RegExp => {
  // Tokenize on path separator; treat standalone `**` segments
  // as "zero or more directory segments" so `src/**/foo.ts`
  // matches `src/foo.ts` (zero) AND `src/a/b/foo.ts` (multiple).
  const segments = glob.split("/")
  const parts: string[] = []
  const DOUBLE_STAR = "\x00DOUBLE_STAR\x00"
  for (const seg of segments) {
    if (seg === "**") {
      parts.push(DOUBLE_STAR)
    } else {
      // Per-segment: escape regex metachars, then `*` → `[^/]*`.
      parts.push(escapeRegex(seg).replace(/\*/g, "[^/]*"))
    }
  }
  // Join then collapse `/DOUBLE_STAR/` / leading / trailing forms so
  // a `**` segment matches zero-or-more PATH segments (not just chars):
  //   `src/**/foo.ts` -> `src/(?:.*/)?foo.ts`
  //   `**/foo.ts`     -> `(?:.*/)?foo.ts`
  //   `src/**`        -> `src(?:/.*)?`
  //   `**`            -> `.*`
  let joined = parts.join("/")
  joined = joined.replace(
    new RegExp(`/${DOUBLE_STAR}/`, "g"),
    "/(?:.*/)?",
  )
  joined = joined.replace(new RegExp(`^${DOUBLE_STAR}/`), "(?:.*/)?")
  joined = joined.replace(new RegExp(`/${DOUBLE_STAR}$`), "(?:/.*)?")
  joined = joined.replace(new RegExp(DOUBLE_STAR, "g"), ".*")
  return new RegExp(`^${joined}$`)
}

const specificityOf = (source: string): number =>
  normalizePathPattern(source).replace(/\*/g, "").length

/** Filter to rules whose `source` matches at least one changed file. */
export const matchVerifyRules = (
  changedFiles: ReadonlyArray<string>,
  rules: ReadonlyArray<VerifyRule>,
): ReadonlyArray<VerifyRule> => {
  const out: VerifyRule[] = []
  for (const r of rules) {
    const re = globToRegex(normalizePathPattern(r.source))
    if (changedFiles.some((f) => re.test(f))) out.push(r)
  }
  return out
}

/**
 * Pick the single verifier command for this Stop. Selection order:
 *   1. lower priority first
 *   2. higher source specificity next (more literal chars)
 *   3. original rule order tie-break (stable)
 * Returns null when no rule matches.
 */
export const selectVerifyCommand = (
  changedFiles: ReadonlyArray<string>,
  rules: ReadonlyArray<VerifyRule>,
): VerifyRule | null => {
  const matched = matchVerifyRules(changedFiles, rules)
  if (matched.length === 0) return null
  const indexed = matched.map((rule, idx) => ({ rule, idx }))
  indexed.sort((a, b) => {
    if (a.rule.priority !== b.rule.priority) return a.rule.priority - b.rule.priority
    const sa = specificityOf(a.rule.source)
    const sb = specificityOf(b.rule.source)
    if (sa !== sb) return sb - sa
    return a.idx - b.idx
  })
  return indexed[0]?.rule ?? null
}

/** Load + parse the verify-map. Returns [] on absence; warns on parse fail. */
export const loadVerifyRules = (
  root: string = process.cwd(),
): ReadonlyArray<VerifyRule> => loadVerifyRulesFromFile(verifyMapPathFor(root))

/**
 * Hard cap on the size of a verify-map file. Files larger than this are
 * rejected with a warn. Bounded to keep the Stop gate's read cost
 * predictable and to limit attack surface from a model-authored
 * per-task verify-map referenced via the ISA `verify_map_path` field.
 * 64 KB easily fits any reasonable rule set.
 */
export const MAX_VERIFY_MAP_BYTES = 64 * 1024

/**
 * Load verify-map rules from an arbitrary file path. Used by the Stop gate
 * to load a per-task verify-map referenced from the active ISA's frontmatter
 * (`verify_map_path: <relative-path>`). Same parser, same semantics, same
 * failure mode as the repo-root loader: returns [] on missing/unreadable
 * file, warns and returns [] on parse failure or oversized file.
 */
export const loadVerifyRulesFromFile = (
  filePath: string,
): ReadonlyArray<VerifyRule> => {
  if (!existsSync(filePath)) return []
  let size: number
  try {
    size = statSync(filePath).size
  } catch {
    return []
  }
  if (size > MAX_VERIFY_MAP_BYTES) {
    logWarningSync(
      `[verify-map] file too large (${size}B > ${MAX_VERIFY_MAP_BYTES}B): ${filePath}`,
    )
    return []
  }
  let raw: string
  try {
    raw = readFileSync(filePath, "utf-8")
  } catch {
    return []
  }
  const parsed = parseVerifyMapYaml(raw)
  if (parsed._tag === "fail") {
    logWarningSync(
      `[verify-map] parse failed for ${filePath}: ${parsed.message}`,
    )
    return []
  }
  return parsed.rules
}

export interface VerifyRunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly durationMs: number
  readonly commandPreview: string
}

const previewOf = (command: string | ReadonlyArray<string>): string =>
  Array.isArray(command) ? command.join(" ") : (command as string)

/**
 * Run a single verify-map rule. Honors `rule.timeoutMs`. Captures stdout +
 * stderr; on non-zero exit OR timeout, returns the captured buffers — the
 * caller is responsible for trimming for the Stop block reason.
 */
export const runVerifyCommand = async (
  rule: VerifyRule,
  cwd: string,
): Promise<VerifyRunResult> => {
  const startedAt = Date.now()
  const commandPreview = previewOf(rule.command)
  const exec = Array.isArray(rule.command)
    ? { cmd: rule.command[0] ?? "", argv: rule.command.slice(1) as string[] }
    : { cmd: "sh", argv: ["-c", rule.command as string] }

  if (exec.cmd.length === 0) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: "verify-map: empty command",
      timedOut: false,
      durationMs: 0,
      commandPreview,
    }
  }

  try {
    const result = Array.isArray(rule.command)
      ? await runCommandLive(exec.cmd, exec.argv, { cwd, timeoutMs: rule.timeoutMs })
      : await runShellCommandLive(rule.command as string, { cwd, timeoutMs: rule.timeoutMs })
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      commandPreview,
    }
  } catch (err) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: String(err),
      timedOut: false,
      durationMs: Date.now() - startedAt,
      commandPreview,
    }
  }
}

/** Trim a buffer to the last `maxChars` characters for human-readable tails. */
export const tailOf = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text
  return `…${text.slice(text.length - maxChars)}`
}
