/**
 * Inspection-whitelist — OPTIONAL user-supplied list of read-only commands
 * that the Stop "inspection-only engagement" gate treats as benign.
 *
 * Loaded from `<projectRoot>/.claude-hooks/inspection-whitelist.yaml`:
 *
 *   commands:
 *     - "ls"
 *     - "git log"
 *     - "git status"
 *
 * Security boundary. The Stop handler uses inspection-status to DECIDE
 * whether a session can finish without an ISA. A maliciously-crafted
 * whitelist entry like `rm -rf` would let a destructive run masquerade
 * as inspection-only. The loader therefore rejects ANY entry containing
 * destructive verbs or shell control characters, logs a warning, and
 * skips the entry. The default (empty file / no file) keeps the hard-
 * coded whitelist behavior unchanged.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { logWarningSync } from "../services/diagnostics.ts"

const WHITELIST_SUBPATH = [".claude-hooks", "inspection-whitelist.yaml"] as const

export const inspectionWhitelistPathFor = (
  root: string = process.cwd(),
): string => join(root, ...WHITELIST_SUBPATH)

/**
 * Verbs / characters that MUST NOT appear in a whitelist entry. This is a
 * deny-list, not a parser — keep it strict. Any match → reject the entry.
 *
 * Note: we match whole words for verbs so a benign substring like `gremlin`
 * doesn't trip the `rm` check, and raw characters for shell control.
 */
const DESTRUCTIVE_VERBS: ReadonlyArray<string> = [
  "rm",
  "mv",
  "cp",
  "chmod",
  "chown",
  "kill",
  "dd",
  "tee",
  "sudo",
  "curl",
  "wget",
  "sh",
  "bash",
  "zsh",
  "eval",
  "exec",
  "source",
]

const SHELL_CONTROL_RE = /[`$;&|<>]|>>|&&|\|\||\$\(/

/**
 * Return `true` when the command string is safe to add to the inspection
 * whitelist. Treats anything ambiguous as unsafe.
 */
export const isSafeInspectionEntry = (cmd: string): boolean => {
  const trimmed = cmd.trim()
  if (trimmed.length === 0) return false
  if (trimmed.length > 200) return false
  if (SHELL_CONTROL_RE.test(trimmed)) return false
  // Reject newlines / tabs / non-printable.
  if (/[\n\r\t\x00-\x08\x0b\x0c\x0e-\x1f]/.test(trimmed)) return false
  // Tokenize on whitespace and check each token against the deny verb list.
  const tokens = trimmed.split(/\s+/)
  for (const tok of tokens) {
    if (DESTRUCTIVE_VERBS.includes(tok)) return false
    // Reject obvious redirection forms even if our regex missed them.
    if (tok === ">" || tok === ">>" || tok === "&&" || tok === "||") return false
  }
  return true
}

interface ParsedWhitelist {
  readonly commands: ReadonlyArray<string>
}

/**
 * Minimal YAML parser for the subset:
 *
 *   commands:
 *     - "ls"
 *     - git log
 *
 * Returns `[]` for any unparseable or unsafe input. Each rejected entry is
 * surfaced via `logWarningSync` so the user knows their config was filtered.
 */
export const parseInspectionWhitelistYaml = (raw: string): ParsedWhitelist => {
  const lines = raw.split("\n")
  let inCommands = false
  const out: string[] = []
  for (const rawLine of lines) {
    // Drop trailing comments (simple — no quote awareness needed because
    // entries cannot legitimately contain `#`).
    const noComment = rawLine.replace(/\s+#.*$/, "")
    const line = noComment.trimEnd()
    if (line.length === 0) continue
    if (/^commands\s*:\s*$/.test(line)) {
      inCommands = true
      continue
    }
    if (!inCommands) continue
    const itemMatch = line.match(/^\s*-\s+(.*)$/)
    if (!itemMatch || itemMatch[1] === undefined) continue
    const value = itemMatch[1].trim().replace(/^["']|["']$/g, "")
    if (!isSafeInspectionEntry(value)) {
      logWarningSync(
        `[inspection-whitelist] rejected unsafe entry: ${value.slice(0, 80)}`,
      )
      continue
    }
    out.push(value)
  }
  return { commands: out }
}

/**
 * Load and return the user's whitelisted inspection commands. Returns `[]`
 * when the file is absent or unreadable — the hard-coded whitelist in
 * `stop-definition-of-done.ts` is the floor.
 */
export const loadInspectionWhitelist = (
  root: string = process.cwd(),
): ReadonlyArray<string> => {
  const p = inspectionWhitelistPathFor(root)
  if (!existsSync(p)) return []
  let raw: string
  try {
    raw = readFileSync(p, "utf-8")
  } catch {
    return []
  }
  return parseInspectionWhitelistYaml(raw).commands
}
