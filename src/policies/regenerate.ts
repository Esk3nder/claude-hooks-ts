/**
 * Doc-integrity regen — declarative "when source files changed, run a
 * command" rules read from `<repo>/.claude-hooks/regenerate.yaml`.
 *
 * NEW DESIGN. PAI has `DocIntegrity.hook.ts` that hardcodes its own regen
 * targets (e.g. `RebuildArchSummary`); this package generalizes the idea
 * via a user-declared YAML file so any project can wire derived-doc regen.
 *
 * YAML shape:
 *
 *   rules:
 *     - source: docs/architecture.md
 *       derived: docs/SUMMARY.md
 *       command: bun run scripts/gen-summary.ts
 *     - source: src/algorithm/v6.3.0.md
 *       derived: src/algorithm/SUMMARY.md
 *       command: ["bun", "run", "scripts/algorithm-summary.ts"]
 *
 * `source` may be a single path OR a glob (wildcards `*` only — no `**`,
 * no brace expansion — keeps the matcher trivial). `command` may be a
 * shell string OR a `[cmd, ...args]` array. The handler picks rules whose
 * `source` matches any file in `SessionState.files_changed` and runs the
 * `command` for each match. Best-effort — failures are logged, never
 * block Stop.
 *
 * The YAML parser is intentionally minimal — same approach as the ISA
 * frontmatter parser. We support: `key: value` (string), nested under a
 * top-level `rules:` list with `- key: value` items. Anything more
 * exotic should be rewritten in JSON or split into multiple files.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const REGENERATE_SUBPATH = [".claude-hooks", "regenerate.yaml"] as const

export const regeneratePathFor = (root: string = process.cwd()): string =>
  join(root, ...REGENERATE_SUBPATH)

export interface RegenerateRule {
  /** File pattern that, when modified, triggers the rule. Wildcards `*` only. */
  readonly source: string
  /** Output file path (advisory — the command is what actually runs). */
  readonly derived: string
  /** Shell string OR [cmd, ...args] array. */
  readonly command: string | ReadonlyArray<string>
}

interface ParseSuccess {
  readonly _tag: "ok"
  readonly rules: ReadonlyArray<RegenerateRule>
}
interface ParseFailure {
  readonly _tag: "fail"
  readonly message: string
}

/**
 * Pure naive parser for the regenerate.yaml subset we support. Returns
 * structured failure on malformed input rather than throwing.
 *
 * Recognized form:
 *   rules:
 *     - source: foo
 *       derived: bar
 *       command: baz
 *   - or -
 *       command: ["bun", "run", "x"]
 *
 * Anything else (block scalars, nested maps beyond rule entries, anchors,
 * tags) is silently skipped at the unrecognized line.
 */
/**
 * Quote-aware trailing-comment strip. Walks the line tracking single/double
 * quote state; cuts at the first whitespace-preceded `#` that is NOT inside
 * a quoted span. Falls back to no-op if no `#` found.
 */
const stripTrailingComment = (line: string): string => {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === "#" && !inSingle && !inDouble) {
      // Require leading whitespace so `command: bun#x` isn't mistaken for a comment.
      const prev = i > 0 ? line[i - 1] : ""
      if (prev === " " || prev === "\t") return line.slice(0, i - 1)
    }
  }
  return line
}

export const parseRegenerateYaml = (raw: string): ParseSuccess | ParseFailure => {
  const lines = raw.split("\n")
  let inRules = false
  const rules: RegenerateRule[] = []
  let current: { source?: string; derived?: string; command?: string | string[] } = {}

  const flush = (): void => {
    if (
      typeof current.source === "string" &&
      typeof current.derived === "string" &&
      current.command !== undefined
    ) {
      rules.push({
        source: current.source,
        derived: current.derived,
        command: current.command,
      })
    }
    current = {}
  }

  for (const rawLine of lines) {
    // F4 fix: strip trailing `# comment` ONLY when the `#` is not inside a
    // quoted value. Pre-fix bug: `command: echo "hi # not a comment"` was
    // truncated at the `#` because the regex didn't respect quotes.
    const line = stripTrailingComment(rawLine).trimEnd()
    if (line.length === 0) continue
    // Top-level `rules:` toggle.
    if (/^rules\s*:\s*$/.test(line)) {
      inRules = true
      continue
    }
    if (!inRules) continue
    // New rule item.
    const itemHeadMatch = line.match(/^\s*-\s+([A-Za-z_]+)\s*:\s*(.*)$/)
    if (itemHeadMatch && itemHeadMatch[1] !== undefined && itemHeadMatch[2] !== undefined) {
      flush()
      const key = itemHeadMatch[1]
      const val = itemHeadMatch[2].trim().replace(/^["']|["']$/g, "")
      if (key === "command" && val.startsWith("[") && val.endsWith("]")) {
        try {
          const arr = JSON.parse(val) as unknown
          if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) {
            current.command = arr as string[]
            continue
          }
        } catch {
          // fall through — treat as string
        }
      }
      if (key === "source" || key === "derived") {
        current[key] = val
      } else if (key === "command") {
        current.command = val
      }
      continue
    }
    // Continuation key under an existing rule (indented).
    const subMatch = line.match(/^\s+([A-Za-z_]+)\s*:\s*(.*)$/)
    if (subMatch && subMatch[1] !== undefined && subMatch[2] !== undefined) {
      const key = subMatch[1]
      const val = subMatch[2].trim().replace(/^["']|["']$/g, "")
      if (key === "command" && val.startsWith("[") && val.endsWith("]")) {
        try {
          const arr = JSON.parse(val) as unknown
          if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) {
            current.command = arr as string[]
            continue
          }
        } catch {
          // fall through
        }
      }
      if (key === "source" || key === "derived") {
        current[key] = val
      } else if (key === "command") {
        current.command = val
      }
    }
  }
  flush()

  return { _tag: "ok", rules }
}

/**
 * Compile a `*`-only glob into a RegExp anchored to start AND end. The
 * package-internal globber is deliberately simple — no `**`, no character
 * classes, no brace expansion. Users wanting more should write a full
 * shell command in `command:` and skip the source filter.
 */
const globToRegex = (glob: string): RegExp => {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`)
}

/**
 * Given changed files + parsed rules, return the rules whose `source`
 * matched at least one changed file. A rule may match multiple files but
 * fires once — caller runs the command once per matched rule.
 */
export const matchRules = (
  changedFiles: ReadonlyArray<string>,
  rules: ReadonlyArray<RegenerateRule>,
): ReadonlyArray<RegenerateRule> => {
  const matched: RegenerateRule[] = []
  for (const r of rules) {
    const re = globToRegex(r.source)
    if (changedFiles.some((f) => re.test(f))) matched.push(r)
  }
  return matched
}

/** Load + parse the regenerate.yaml file. Returns [] on absence or error. */
export const loadRegenerateRules = (
  root: string = process.cwd(),
): ReadonlyArray<RegenerateRule> => {
  const p = regeneratePathFor(root)
  if (!existsSync(p)) return []
  let raw: string
  try {
    raw = readFileSync(p, "utf-8")
  } catch {
    return []
  }
  const parsed = parseRegenerateYaml(raw)
  if (parsed._tag === "fail") {
    process.stderr.write(`[regenerate] parse failed: ${parsed.message}\n`)
    return []
  }
  return parsed.rules
}
