/**
 * Engagement gate — enforces the "ALGORITHM tier ≥ 3 must produce an ISA
 * before any non-ISA implementation work" rule at PreToolUse time.
 *
 * Pure: takes already-normalized facts as parameters, returns a
 * PolicyDecision. The Effect-side wrapper in `events/pretool-policy.ts`
 * is responsible for path resolution: turning relative paths absolute,
 * resolving `..`, and following symlinks via realpath where possible.
 * The gate compares post-normalization strings only.
 *
 * Release condition (gate becomes inert):
 *   - engagement_required is false, OR
 *   - any of `acceptedIsaPaths` exists on disk (signaled by the wrapper
 *     via `anyAcceptedIsaExists`).
 *
 * Acceptance lists (computed by the wrapper from cwd + SessionState):
 *   - `acceptedWritePaths`: absolute paths the model may target with
 *     Write/Update/NotebookEdit. Always exactly the expected per-task ISA
 *     path. Creating a fresh project ISA via Write is NOT permitted —
 *     that would let the model invent its own ISA location and bypass
 *     the deterministic-path contract.
 *   - `acceptedEditPaths`: absolute paths for Edit/MultiEdit. Includes
 *     the expected per-task ISA path AND the project ISA at `<cwd>/ISA.md`
 *     if it already exists on disk. Aligns with the Stop gate's broader
 *     acceptance: an existing project ISA is a legitimate target the
 *     ENGAGE directive explicitly permits ("or update the project ISA").
 *   - `acceptedMkdirDirs`: absolute directories `mkdir [-p] <dir>` may
 *     create. Typically just the parent of the expected per-task ISA.
 *
 * Allowed during engagement (no accepted ISA on disk yet):
 *   - Read / Glob / Grep / LS / TodoWrite / Task / Skill / WebFetch /
 *     WebSearch / AskUserQuestion / ExitPlanMode / NotebookRead — all
 *     read-only or planning tools.
 *   - Edit / MultiEdit when the resolved input path is in
 *     `acceptedEditPaths`.
 *   - Write / Update / NotebookEdit when the resolved input path is in
 *     `acceptedWritePaths`.
 *   - Bash when the command is `mkdir` of a directory in
 *     `acceptedMkdirDirs` (or a bare `mkdir` / `mkdir -p`).
 *
 * Denied: every other Edit/Write/MultiEdit/Bash invocation.
 */

import type { PolicyDecision } from "./types.ts"

export interface EngagementContext {
  readonly engagement_required: boolean
  /** Whether any path in `acceptedIsaPaths` exists on disk. Disk is the
   *  source of truth for gate release; the wrapper computes this. */
  readonly anyAcceptedIsaExists: boolean
  /** Resolved absolute paths the model may Write to. */
  readonly acceptedWritePaths: ReadonlyArray<string>
  /** Resolved absolute paths the model may Edit/MultiEdit. Superset of
   *  `acceptedWritePaths` (adds the project ISA when it already exists). */
  readonly acceptedEditPaths: ReadonlyArray<string>
  /** Resolved absolute directories the model may `mkdir`. */
  readonly acceptedMkdirDirs: ReadonlyArray<string>
  /** Display path for the deny message — typically the project-relative
   *  expected_isa_path so the model sees the same string the prompt-router
   *  directive used. May be null when SessionState lacks it. */
  readonly displayIsaPath: string | null
  /** Display directory for the deny message — typically the relative
   *  parent of `displayIsaPath`. */
  readonly displayMkdirDir: string | null
  /** Resolved absolute path of the tool's file_path target after symlink
   *  + traversal normalization. null when N/A or unresolvable. */
  readonly resolvedToolFilePath: string | null
  readonly toolName: string
  readonly toolInput: unknown
}

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
 * Allowed Bash forms during engagement: only `mkdir` of an explicitly
 * accepted directory (or a no-arg / bare `mkdir`/`mkdir -p`). Anything
 * else — `sudo mkdir`, chained commands, mkdir of unrelated paths — is
 * denied.
 */
const isAllowedMkdir = (
  cmd: string,
  acceptedDirs: ReadonlyArray<string>,
): boolean => {
  const trimmed = cmd.trim()
  // Reject anything with shell control characters that could chain a write.
  if (/[;&|`$<>]/.test(trimmed)) return false
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
): string => {
  const path = displayIsaPath ?? "<.claude-hooks/state/work/<slug>/ISA.md>"
  const dir = displayMkdirDir ?? "<isa-dir>"
  return (
    `ALGORITHM engagement is required before implementation.\n` +
    `\n` +
    `This session classified as ALGORITHM tier ≥ 3. Before using ` +
    `implementation tools (${toolName} on a non-ISA target was just ` +
    `attempted), create the ISA at:\n` +
    `\n` +
    `  ${path}\n` +
    `\n` +
    `Allowed now:\n` +
    `  - Read / LS / Glob / Grep for inspection\n` +
    `  - Write to the expected ISA path above\n` +
    `  - Edit / MultiEdit to that path OR an existing <repo>/ISA.md\n` +
    `  - Bash only for \`mkdir -p ${dir}\`\n` +
    `\n` +
    `After the ISA exists, the gate releases automatically and you may ` +
    `continue normally. Disk is the source of truth — the gate checks ` +
    `the actual filesystem, not in-memory state. Set ` +
    `CLAUDE_HOOKS_DISABLE_ISA_PRETOOL_GATE=1 in the hook environment to ` +
    `bypass in emergencies.`
  )
}

export const evaluateEngagementGate = (
  ctx: EngagementContext,
): PolicyDecision => {
  // Outside engagement → no opinion.
  if (!ctx.engagement_required) return { kind: "passthrough" }
  // Once an accepted ISA exists on disk, the gate releases.
  if (ctx.anyAcceptedIsaExists) return { kind: "passthrough" }
  // No enforceable target means we cannot lock down a deterministic
  // write path; fail open rather than blocking all tools.
  if (ctx.acceptedWritePaths.length === 0) return { kind: "passthrough" }

  // Always-allowed tools during engagement.
  if (ALLOWED_TOOLS_DURING_ENGAGEMENT.has(ctx.toolName)) {
    return { kind: "passthrough" }
  }

  // Edit/MultiEdit: allow either accepted-write OR accepted-edit target
  // (project ISA if it exists). The wrapper has already normalized the
  // input path and the accepted paths to absolute realpath form.
  if (
    ctx.toolName === "Edit" ||
    ctx.toolName === "MultiEdit"
  ) {
    if (
      ctx.resolvedToolFilePath !== null &&
      ctx.acceptedEditPaths.includes(ctx.resolvedToolFilePath)
    ) {
      return { kind: "passthrough" }
    }
    return {
      kind: "deny",
      reason: denyReason(
        ctx.toolName,
        ctx.displayIsaPath,
        ctx.displayMkdirDir,
      ),
    }
  }

  // Write / Update / NotebookEdit: allow ONLY the deterministic per-task
  // ISA path. Creating a new project ISA from scratch is intentionally
  // disallowed here — the directive promised a specific location.
  if (
    ctx.toolName === "Write" ||
    ctx.toolName === "Update" ||
    ctx.toolName === "NotebookEdit"
  ) {
    if (
      ctx.resolvedToolFilePath !== null &&
      ctx.acceptedWritePaths.includes(ctx.resolvedToolFilePath)
    ) {
      return { kind: "passthrough" }
    }
    return {
      kind: "deny",
      reason: denyReason(
        ctx.toolName,
        ctx.displayIsaPath,
        ctx.displayMkdirDir,
      ),
    }
  }

  // Bash: allow only `mkdir` of an accepted directory.
  if (ctx.toolName === "Bash") {
    const cmd = commandFromInput(ctx.toolInput)
    if (cmd !== null && isAllowedMkdir(cmd, ctx.acceptedMkdirDirs)) {
      return { kind: "passthrough" }
    }
    return {
      kind: "deny",
      reason: denyReason(
        ctx.toolName,
        ctx.displayIsaPath,
        ctx.displayMkdirDir,
      ),
    }
  }

  // Unknown tools (e.g. third-party MCP tools) — be permissive. The
  // engagement gate is about implementation work, not policy lockdown.
  return { kind: "passthrough" }
}
