/**
 * ISC checkpoint — auto git commit on every ISC `[ ]`→`[x]` transition.
 *
 * 's `~/.claude/hooks/CheckpointPerISC.hook.ts` (lines
 * 26-200). One path adaptation called out below; everything else (commit
 * subject form, idempotency via sidecar state, allowlist semantics, fail-
 * closed error policy, --no-verify --no-gpg-sign flags, 5000ms git timeout)
 * implements canonical behavior byte-for-byte.
 *
 * SAFETY POSTURE (verbatim from the classifier): "Fails closed — any error
 * path logs to stderr and emits `{continue:true}` with exit 0; never crashes
 * the session, never commits without an allowlist, never executes any
 * destructive git op (no reset/revert/checkout/branch -D/clean -fd/
 * push --force)."
 *
 * Default behavior on a fresh install: ZERO commits. The allowlist file
 * does not exist by default; users opt in repos explicitly. This is
 * deliberate — auto-commit on a public package without explicit opt-in
 * would be a footgun.
 *
 * PATH ADAPTATION (the only divergence canonically):
 * this package allowlist: `~/.claude/checkpoint-repos.txt` (per-user, single file).
 * This package: `<repo>/.claude-hooks/checkpoint-repos.txt` (per-repo,
 * mirrors `services/session-state.ts` `.claude-hooks/state/`
 * convention). Each project opts in its own repos. Tilde
 * and $HOME prefixes inside the file are still expanded.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { basename, dirname, join } from "node:path"
import { homedir } from "node:os"
import { parseCriteriaList, type CriterionEntry } from "./criteria.ts"
import { parseFrontmatter } from "./frontmatter.ts"

/** the classifier — git command timeout. */
export const GIT_TIMEOUT_MS = 5000

/**
 * Allowlist filename relative to a project root. Users opt in repos by
 * creating `<root>/.claude-hooks/checkpoint-repos.txt` with one absolute
 * (or `~/`-prefixed) path per line. `#` comments and blank lines ignored.
 */
const ALLOWLIST_SUBPATH = [".claude-hooks", "checkpoint-repos.txt"] as const

export const allowlistPathFor = (root: string = process.cwd()): string =>
  join(root, ...ALLOWLIST_SUBPATH)

/** Sidecar file that records which ISCs we've already committed for a slug. */
export const STATE_FILENAME = ".checkpoint-state.json"

export interface CheckpointState {
  readonly committed_iscs: ReadonlyArray<string>
  readonly last_commit_sha: Readonly<Record<string, string>>
}

/** the classifier — expand `~` and `$HOME` prefixes in allowlist entries. */
export const expandPath = (p: string): string => {
  let s = p.trim()
  if (!s) return s
  if (s.startsWith("~/")) s = join(homedir(), s.slice(2))
  else if (s === "~") s = homedir()
  s = s.replace(/^\$HOME(\/|$)/, `${homedir()}$1`)
  return s
}

/** the classifier — read allowlist, ignore comments/blanks, expand prefixes. */
export const loadAllowlist = (
  root: string = process.cwd(),
): ReadonlyArray<string> => {
  const allowlistPath = allowlistPathFor(root)
  if (!existsSync(allowlistPath)) return []
  try {
    return readFileSync(allowlistPath, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"))
      .map(expandPath)
  } catch (err) {
    process.stderr.write(
      `[checkpoint] failed to read allowlist: ${String(err)}\n`,
    )
    return []
  }
}

/** the classifier — load idempotency state from sidecar JSON. */
export const loadState = (stateFile: string): CheckpointState => {
  if (!existsSync(stateFile)) {
    return { committed_iscs: [], last_commit_sha: {} }
  }
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf-8")) as {
      committed_iscs?: unknown
      last_commit_sha?: unknown
    }
    return {
      committed_iscs: Array.isArray(parsed.committed_iscs)
        ? (parsed.committed_iscs.filter(
            (x): x is string => typeof x === "string",
          ) as ReadonlyArray<string>)
        : [],
      last_commit_sha:
        parsed.last_commit_sha !== null &&
        typeof parsed.last_commit_sha === "object"
          ? (parsed.last_commit_sha as Record<string, string>)
          : {},
    }
  } catch (err) {
    process.stderr.write(
      `[checkpoint] malformed state file ${stateFile}, resetting: ${String(err)}\n`,
    )
    return { committed_iscs: [], last_commit_sha: {} }
  }
}

/** the classifier — best-effort state write; failures logged not thrown. */
export const saveState = (stateFile: string, state: CheckpointState): void => {
  try {
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf-8")
  } catch (err) {
    process.stderr.write(
      `[checkpoint] failed to write state ${stateFile}: ${String(err)}\n`,
    )
  }
}

/** the classifier — synchronous git invocation via execFileSync. */
const gitRun = (repo: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf-8",
    timeout: GIT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  })

/** the classifier. */
export const isGitRepo = (repo: string): boolean => {
  try {
    gitRun(repo, ["rev-parse", "--git-dir"])
    return true
  } catch {
    return false
  }
}

/** the classifier — `git status --porcelain` truthiness. */
export const hasChanges = (repo: string): boolean => {
  try {
    return gitRun(repo, ["status", "--porcelain"]).trim().length > 0
  } catch {
    return false
  }
}

/** the classifier — single-line, length-capped, backtick/`$` stripped. */
export const sanitizeMessage = (s: string): string =>
  s.replace(/\s+/g, " ").replace(/[`$]/g, "").trim().slice(0, 200)

/**
 * the classifier — commit one ISC transition in one repo. Subject form:
 * "<ISC-id> (<slug>): <sanitized description>"
 * `--no-verify` skips husky/pre-commit hooks; `--no-gpg-sign` avoids GPG
 * passphrase prompts that would block the session on stdin.
 *
 * Returns commit SHA on success, null on failure (logged to stderr).
 */
export const commitInRepo = (
  repo: string,
  iscId: string,
  slug: string,
  description: string,
): string | null => {
  try {
    gitRun(repo, ["add", "-A"])
    const subject = `${iscId} (${slug}): ${sanitizeMessage(description)}`
    gitRun(repo, [
      "commit",
      "-m",
      subject,
      "--quiet",
      "--no-verify",
      "--no-gpg-sign",
    ])
    const sha = gitRun(repo, ["rev-parse", "HEAD"]).trim()
    return sha
  } catch (err) {
    const e = err as { stderr?: { toString?: () => string }; message?: string }
    const detail = e.stderr?.toString?.() ?? e.message ?? String(err)
    process.stderr.write(
      `[checkpoint] commit failed in ${repo} for ${iscId}: ${detail}\n`,
    )
    return null
  }
}

/**
 * Pure planner: given parsed criteria + prior state, return the list of
 * ISCs that just transitioned to completed. Used by tests and by the
 * handler to decide whether any work needs to happen.
 */
export const newlyCompletedISCs = (
  criteria: ReadonlyArray<CriterionEntry>,
  state: CheckpointState,
): ReadonlyArray<CriterionEntry> => {
  const already = new Set(state.committed_iscs)
  return criteria.filter((c) => c.status === "completed" && !already.has(c.id))
}

/**
 * Top-level orchestrator. implements canonical behavior main() (lines 146-193) — given the
 * absolute path to a just-edited ISA file, parses it, computes the ISC
 * transitions since last invocation, and creates one git commit per
 * allowlisted repo per newly-completed ISC. Returns a summary so callers
 * (the post-edit-quality handler) can log/report.
 *
 * Called by the PostToolUse handler. Never throws — all errors logged
 * to stderr and a partial-or-empty result returned.
 */
export interface CheckpointResult {
  readonly iscIds: ReadonlyArray<string>
  readonly commits: ReadonlyArray<{
    readonly iscId: string
    readonly repo: string
    readonly sha: string
  }>
  readonly skipped:
    | "no-allowlist"
    | "no-criteria"
    | "no-frontmatter"
    | "missing-file"
    | null
}

export const runCheckpoint = (
  isaFilePath: string,
  root: string = process.cwd(),
): CheckpointResult => {
  const empty = (skipped: CheckpointResult["skipped"]): CheckpointResult => ({
    iscIds: [],
    commits: [],
    skipped,
  })

  if (!existsSync(isaFilePath)) return empty("missing-file")

  const slugDir = dirname(isaFilePath)
  const slug = basename(slugDir)
  const stateFile = join(slugDir, STATE_FILENAME)

  let content: string
  try {
    content = readFileSync(isaFilePath, "utf-8")
  } catch (err) {
    process.stderr.write(
      `[checkpoint] failed to read ${isaFilePath}: ${String(err)}\n`,
    )
    return empty("missing-file")
  }

  const fm = parseFrontmatter(content)
  if (fm === null) return empty("no-frontmatter")

  const criteria = parseCriteriaList(content)
  if (criteria.length === 0) return empty("no-criteria")

  const state = loadState(stateFile)
  const newly = newlyCompletedISCs(criteria, state)
  if (newly.length === 0) {
    return { iscIds: [], commits: [], skipped: null }
  }

  const allowlist = loadAllowlist(root)
  if (allowlist.length === 0) {
    process.stderr.write("[checkpoint] no repos configured, skipping\n")
    return empty("no-allowlist")
  }

  const commits: Array<{ iscId: string; repo: string; sha: string }> = []
  const committedIds: string[] = [...state.committed_iscs]
  const lastCommitSha: Record<string, string> = { ...state.last_commit_sha }

  for (const isc of newly) {
    for (const repo of allowlist) {
      if (!existsSync(repo)) {
        process.stderr.write(`[checkpoint] repo not found: ${repo}\n`)
        continue
      }
      if (!isGitRepo(repo)) {
        process.stderr.write(`[checkpoint] not a git repo: ${repo}\n`)
        continue
      }
      if (!hasChanges(repo)) continue
      const sha = commitInRepo(repo, isc.id, slug, isc.description)
      if (sha !== null) {
        lastCommitSha[repo] = sha
        commits.push({ iscId: isc.id, repo, sha })
      }
    }
    committedIds.push(isc.id)
  }

  saveState(stateFile, {
    committed_iscs: committedIds,
    last_commit_sha: lastCommitSha,
  })

  return {
    iscIds: newly.map((c) => c.id),
    commits,
    skipped: null,
  }
}
