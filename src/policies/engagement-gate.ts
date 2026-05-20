/**
 * Engagement gate — enforces the "ALGORITHM tier ≥ 3 must produce an ISA
 * before any non-ISA implementation work" rule at PreToolUse time.
 *
 * Deep module: given (currentCwd, sessionRoot, record, toolName, toolInput),
 * decides allow / deny / passthrough without external pre-computation.
 * Internally builds accepted-path lists (write / edit / mkdir) from the
 * SessionState record and the two cwd roots, then dispatches on tool.
 *
 * Roots:
 *   - currentCwd: shell cwd at hook time (mutable; tracks Bash `cd`).
 *     Used ONLY for resolving the tool's own input path, because the
 *     model writes relative paths against the current shell cwd.
 *   - sessionRoot: project root frozen at engagement creation. Used for
 *     everything ISA-identity-related (expected ISA path resolution,
 *     project ISA at `<sessionRoot>/ISA.md`).
 *
 * Release condition (gate becomes inert for non-ISA tools):
 *   - engagement_required is false, OR
 *   - the expected per-task ISA exists on disk, OR
 *   - a project ISA exists at `<sessionRoot>/ISA.md` (Stop-gate alignment).
 *
 * Acceptance:
 *   - Write / Update / NotebookEdit: explicitly allow ONLY the deterministic
 *     expected per-task ISA path. Creating a fresh project ISA via Write is
 *     intentionally not permitted — the directive promised a specific
 *     location.
 *   - Edit / MultiEdit: explicitly allow the expected per-task ISA path OR
 *     the project ISA at `<sessionRoot>/ISA.md` if it exists on disk.
 *   - Bash mkdir: the parent of the expected per-task ISA (absolute) OR
 *     the relative spelling of that parent when `currentCwd === sessionRoot`.
 *   - Bash inspection: harmless cwd/repo/worker-state discovery before
 *     writing the ISA (`pwd`, `rg ...`, `claude-hooks-workers list`).
 *
 * Other tools (Read / Glob / Grep / LS / TodoWrite / Task / Skill / etc.)
 * always pass through during engagement. Unknown tools (third-party MCP)
 * are permissive — this gate is about implementation work, not lockdown.
 *
 * The shallow form (`evaluateEngagementGateShallow`) remains exported so
 * the pure decision matrix can be unit-tested in isolation against
 * already-normalized inputs.
 */

import { existsSync } from "node:fs"
import { dirname } from "node:path"
import type { PolicyDecision } from "./types.ts"
import { safeResolvePath } from "../services/path-resolution.ts"
import type { SessionStateRecord } from "../services/session-state.ts"
import { resolveExpectedIsaAbsolute } from "../algorithm/isa/path-contract.ts"
import {
  normalizeExpectedIsaPath,
} from "../algorithm/isa/tier-policy.ts"
import { isUnknownTool } from "./write-class.ts"

export interface EngagementGateInput {
  readonly currentCwd: string
  readonly sessionRoot: string
  readonly record: SessionStateRecord
  readonly toolName: string
  readonly toolInput: unknown
}

export type EngagementVerdict = PolicyDecision

const ALLOWED_TOOLS_DURING_ENGAGEMENT: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "List",
  "TodoWrite",
  "Task",
  "Skill",
  "WebFetch",
  "WebSearch",
  "AskUserQuestion",
  "ExitPlanMode",
  "NotebookRead",
])

const commandFromInput = (input: unknown): string | null => {
  if (typeof input !== "object" || input === null) return null
  const c = (input as { command?: unknown }).command
  return typeof c === "string" ? c : null
}

/**
 * Allowed Bash forms during engagement: only read-only inspection commands
 * (`pwd`, `rg ...`, `claude-hooks-workers list`) and `mkdir` of an explicitly
 * accepted directory (or a no-arg / bare `mkdir` / `mkdir -p`). Anything else
 * — `sudo mkdir`, chained commands, worker mutation commands, mkdir of
 * unrelated paths — is denied.
 */
const hasUnquotedShellControl = (cmd: string): boolean => {
  let quote: "'" | "\"" | null = null
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd.charAt(i)
    if (ch === "\n" || ch === "\r" || ch === "`" || ch === "$") return true
    if (ch === "'" || ch === "\"") {
      quote = quote === ch ? null : quote === null ? ch : quote
      continue
    }
    if (quote === null && /[;&|<>]/.test(ch)) return true
  }
  return quote !== null
}

const shellWords = (cmd: string): ReadonlyArray<string> | null => {
  const words: string[] = []
  let current = ""
  let quote: "'" | "\"" | null = null
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd.charAt(i)
    if (ch === "'" || ch === "\"") {
      quote = quote === ch ? null : quote === null ? ch : quote
      continue
    }
    if (quote === null && /\s/.test(ch)) {
      if (current.length > 0) {
        words.push(current)
        current = ""
      }
      continue
    }
    current += ch
  }
  if (quote !== null) return null
  if (current.length > 0) words.push(current)
  return words
}

const isSafeRipgrepInspection = (trimmed: string): boolean => {
  const words = shellWords(trimmed)
  if (words === null || words[0] !== "rg") return false
  return !words.slice(1).some((word) =>
    word === "--pre" ||
    word.startsWith("--pre=") ||
    word === "--pre-glob" ||
    word.startsWith("--pre-glob=") ||
    word === "--config" ||
    word.startsWith("--config=")
  )
}

const isAllowedReadOnlyInspectionBash = (cmd: string): boolean => {
  const trimmed = cmd.trim()
  if (hasUnquotedShellControl(trimmed)) return false
  if (trimmed === "pwd") return true
  if (isSafeRipgrepInspection(trimmed)) return true
  return (
    trimmed === "./bin/claude-hooks-workers list" ||
    trimmed === "./bin/claude-hooks-workers list --json"
  )
}

const isAllowedMkdir = (
  cmd: string,
  acceptedDirs: ReadonlyArray<string>,
): boolean => {
  const trimmed = cmd.trim()
  // Reject anything with shell control characters that could chain a write.
  if (hasUnquotedShellControl(trimmed)) return false
  if (trimmed === "mkdir" || trimmed === "mkdir -p") return true
  for (const dir of acceptedDirs) {
    const normalized = dir.replace(/\/$/, "")
    const patterns = [
      `mkdir ${normalized}`,
      `mkdir ${normalized}/`,
      `mkdir -p ${normalized}`,
      `mkdir -p ${normalized}/`,
    ]
    if (patterns.includes(trimmed)) return true
  }
  return false
}

const denyReason = (
  toolName: string,
  displayIsaPath: string | null,
  displayMkdirDir: string | null,
  displayIsaAbsolutePath: string | null,
): string => {
  const rel = displayIsaPath ?? "<.claude-hooks/work/<slug>/ISA.md>"
  const dir = displayMkdirDir ?? "<isa-dir>"
  // The relative path is what the directive named for readability;
  // the absolute path disambiguates when the shell has drifted away
  // from `session_root` (Bash `cd ~/.claude/skills/...`). We surface
  // both so the model has an unambiguous target regardless of cwd.
  const absoluteLine =
    displayIsaAbsolutePath !== null && displayIsaAbsolutePath !== rel
      ? `  ${rel}\n  (absolute: ${displayIsaAbsolutePath})`
      : `  ${rel}`
  return (
    `ISA required before this tool can run.\n` +
    `\n` +
    `This session is ALGORITHM tier ≥ 3; ${toolName} targeted a non-ISA ` +
    `path before the ISA exists. Create or update:\n` +
    `\n` +
    `${absoluteLine}\n` +
    `\n` +
    `Allowed now:\n` +
    `  - Write to the expected ISA path above\n` +
    `  - Edit / MultiEdit to that path OR an existing <repo>/ISA.md\n` +
    `  - Read / LS / Glob / Grep, Bash \`pwd\`, ` +
    `\`rg ...\`, or \`./bin/claude-hooks-workers list [--json]\` for inspection\n` +
    `  - Bash only for \`mkdir -p ${dir}\`\n` +
    `\n` +
    `After the ISA exists on disk, retry the blocked tool.`
  )
}

/** Internal shallow form — operates on already-normalized facts. Kept
 *  exported so the pure decision matrix can be unit-tested in isolation
 *  (see test/policies/engagement-gate.test.ts). */
export interface EngagementContext {
  readonly engagement_required: boolean
  readonly anyAcceptedIsaExists: boolean
  readonly acceptedWritePaths: ReadonlyArray<string>
  readonly acceptedEditPaths: ReadonlyArray<string>
  readonly acceptedMkdirDirs: ReadonlyArray<string>
  readonly displayIsaPath: string | null
  /** Absolute form of the expected ISA path. Surfaced in deny messages
   *  alongside `displayIsaPath` so the model has an unambiguous target
   *  even when the shell cwd has drifted away from `session_root`.
   *  Optional for backward compatibility with shallow-form callers; the
   *  deep entry point (`evaluateEngagementGate`) always populates it. */
  readonly displayIsaAbsolutePath?: string | null
  readonly displayMkdirDir: string | null
  readonly resolvedToolFilePath: string | null
  readonly toolName: string
  readonly toolInput: unknown
}

export const evaluateEngagementGateShallow = (
  ctx: EngagementContext,
): PolicyDecision => {
  if (!ctx.engagement_required) return { kind: "passthrough" }
  // Enforcement-plane P1 #4 (shallow-form mirror): if engagement is
  // required but the caller has no accepted write paths to enforce
  // against, that's the same corrupt-state signal the deep entry
  // catches at :363. Mirror the `ask` here so the shallow form is
  // also defense-in-depth-safe — currently all production callers
  // go through the deep entry, but the shallow form is exported and
  // a future caller driving it directly would otherwise still fail
  // open. (PR #73 review #3.)
  if (ctx.acceptedWritePaths.length === 0) {
    return {
      kind: "ask",
      reason:
        "Engagement state is corrupt: no accepted write paths " +
        "available even though `engagement_required=true`. The " +
        "deep entry produces this state when `expected_isa_path` " +
        "is null — repair via UserPromptSubmit re-run.",
    }
  }

  const targetsAcceptedEditPath =
    ctx.resolvedToolFilePath !== null &&
    ctx.acceptedEditPaths.includes(ctx.resolvedToolFilePath)
  const targetsAcceptedWritePath =
    ctx.resolvedToolFilePath !== null &&
    ctx.acceptedWritePaths.includes(ctx.resolvedToolFilePath)

  if (
    (ctx.toolName === "Edit" || ctx.toolName === "MultiEdit") &&
    targetsAcceptedEditPath
  ) {
    return {
      kind: "allow",
      reason:
        "Scoped ISA artifact edit allowed for this engaged ALGORITHM session.",
    }
  }

  if (
    (ctx.toolName === "Write" ||
      ctx.toolName === "Update" ||
      ctx.toolName === "NotebookEdit") &&
    targetsAcceptedWritePath
  ) {
    return {
      kind: "allow",
      reason:
        "Scoped ISA artifact write allowed for this engaged ALGORITHM session.",
    }
  }

  if (ctx.anyAcceptedIsaExists) return { kind: "passthrough" }

  if (ALLOWED_TOOLS_DURING_ENGAGEMENT.has(ctx.toolName)) {
    return { kind: "passthrough" }
  }

  if (ctx.toolName === "Edit" || ctx.toolName === "MultiEdit") {
    return {
      kind: "deny",
      reason: denyReason(
        ctx.toolName,
        ctx.displayIsaPath,
        ctx.displayMkdirDir,
        ctx.displayIsaAbsolutePath ?? null,
      ),
    }
  }

  if (
    ctx.toolName === "Write" ||
    ctx.toolName === "Update" ||
    ctx.toolName === "NotebookEdit"
  ) {
    return {
      kind: "deny",
      reason: denyReason(
        ctx.toolName,
        ctx.displayIsaPath,
        ctx.displayMkdirDir,
        ctx.displayIsaAbsolutePath ?? null,
      ),
    }
  }

  if (ctx.toolName === "Bash") {
    const cmd = commandFromInput(ctx.toolInput)
    if (
      cmd !== null &&
      (isAllowedReadOnlyInspectionBash(cmd) || isAllowedMkdir(cmd, ctx.acceptedMkdirDirs))
    ) {
      return { kind: "passthrough" }
    }
    return {
      kind: "deny",
      reason: denyReason(
        ctx.toolName,
        ctx.displayIsaPath,
        ctx.displayMkdirDir,
        ctx.displayIsaAbsolutePath ?? null,
      ),
    }
  }

  // Enforcement-plane P0 #3: unknown / MCP tools during pre-ISA
  // engagement. Without this branch, any tool not in
  // ALLOWED_TOOLS_DURING_ENGAGEMENT (and not in our known write/Bash
  // branches above) silently passed through. An MCP filesystem-write
  // tool could therefore bypass the "no implementation before ISA"
  // invariant entirely.
  //
  // Decision: `ask`, not `deny`. Real users have read-only MCP servers
  // (`mcp__docs__search`, `mcp__linear__get_issue`); blocking outright
  // would force a config file. Ask lets the user confirm once. A
  // future story can add an explicit read-only allowlist.
  if (isUnknownTool(ctx.toolName)) {
    return {
      kind: "ask",
      reason:
        `Unknown tool \`${ctx.toolName}\` invoked during pre-ISA engagement. ` +
        `Confirm this tool does not mutate files before the ISA is scaffolded. ` +
        `If you are sure it's read-only, you may approve; otherwise create the ISA first ` +
        `at ${ctx.displayIsaPath ?? "the expected ISA path"} and then retry.`,
    }
  }

  return { kind: "passthrough" }
}

/**
 * Deep entry point: takes raw session+tool facts and decides allow / deny.
 * Owns accepted-path construction (write / edit / mkdir) internally so the
 * caller (pretool-policy.ts) doesn't have to know the rules.
 */
export const evaluateEngagementGate = (
  input: EngagementGateInput,
): EngagementVerdict => {
  const { currentCwd, sessionRoot, record, toolName, toolInput } = input

  // Outside engagement → no opinion.
  if (!record.engagement_required) return { kind: "passthrough" }
  // Enforcement-plane P1 #4: engagement_required=true with no
  // expected_isa_path is corrupt state — pre-fix this fell open,
  // disabling the gate exactly when state said engagement was
  // required. Now: `ask` with a repair message. Reading: the user
  // either confirms a one-off bypass or fixes state (re-run
  // UserPromptSubmit; the prompt-router will regenerate the
  // engagement bookkeeping).
  if (record.expected_isa_path === null) {
    return {
      kind: "ask",
      reason:
        "Engagement state is corrupt: `engagement_required=true` " +
        "but `expected_isa_path` is missing. Re-run UserPromptSubmit " +
        "to regenerate the engagement bookkeeping, or scaffold the " +
        "ISA manually before proceeding.",
    }
  }

  const expectedRelative = normalizeExpectedIsaPath(record.expected_isa_path)
  const expectedAbsolute = resolveExpectedIsaAbsolute(sessionRoot, record)
  const expectedDir =
    expectedAbsolute !== null ? dirname(expectedAbsolute) : null
  const expectedIsaExists =
    expectedAbsolute !== null && existsSync(expectedAbsolute)

  const projectIsaAbsolute = safeResolvePath(sessionRoot, "ISA.md")
  const projectIsaExists =
    projectIsaAbsolute !== null && existsSync(projectIsaAbsolute)

  const acceptedWritePaths =
    expectedAbsolute !== null ? [expectedAbsolute] : ["<invalid-isa-target>"]
  const acceptedEditPaths =
    projectIsaExists && projectIsaAbsolute !== null
      ? [...acceptedWritePaths, projectIsaAbsolute]
      : acceptedWritePaths

  // Bash mkdir comparison is string-based (no path resolution),
  // so accept the absolute form unconditionally and the relative
  // forms ONLY when the shell's current cwd is the session root.
  // Without that guard, `mkdir -p .claude-hooks/work/<sid>` would
  // be accepted while cwd has drifted into e.g. ~/.claude/skills/...,
  // letting the model plant a fake ISA outside the project.
  const acceptedMkdirDirs: string[] = []
  if (expectedDir !== null) acceptedMkdirDirs.push(expectedDir)
  const currentCwdResolved =
    safeResolvePath(currentCwd, ".") ?? currentCwd
  const sessionRootResolved =
    safeResolvePath(sessionRoot, ".") ?? sessionRoot
  const cwdIsSessionRoot = currentCwdResolved === sessionRootResolved
  const expectedDirRelative =
    expectedRelative === null ? null : dirname(expectedRelative)
  const pushIfNew = (d: string): void => {
    if (d.length > 0 && !acceptedMkdirDirs.includes(d)) {
      acceptedMkdirDirs.push(d)
    }
  }
  if (cwdIsSessionRoot) {
    // The model can spell relative paths several common ways. Accept
    // the bare relative form AND a leading `./` form (`./foo/bar`),
    // since the engagement-gate's whitelist is exact-string.
    if (expectedDirRelative !== null) pushIfNew(expectedDirRelative)
    if (
      expectedDirRelative !== null &&
      expectedDirRelative !== "." &&
      !expectedDirRelative.startsWith("./") &&
      !expectedDirRelative.startsWith("/")
    ) {
      pushIfNew(`./${expectedDirRelative}`)
    }
  }

  const anyAcceptedIsaExists = expectedIsaExists || projectIsaExists

  const inputFp =
    typeof toolInput === "object" && toolInput !== null
      ? (toolInput as { file_path?: unknown }).file_path
      : undefined
  const resolvedToolFilePath = safeResolvePath(currentCwd, inputFp)

  return evaluateEngagementGateShallow({
    engagement_required: record.engagement_required,
    anyAcceptedIsaExists,
    acceptedWritePaths,
    acceptedEditPaths,
    acceptedMkdirDirs,
    displayIsaPath: expectedRelative ?? record.expected_isa_path,
    displayIsaAbsolutePath: expectedAbsolute,
    displayMkdirDir: expectedDir,
    resolvedToolFilePath,
    toolName,
    toolInput,
  })
}
