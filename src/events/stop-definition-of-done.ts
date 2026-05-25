import { Effect } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, win32 } from "node:path"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { NO_DECISION } from "../schema/decisions.ts"
import { SessionState } from "../services/session-state.ts"
import { checkStopReadiness, resolveActiveIsa } from "../algorithm/isa/lifecycle.ts"
import { resolveExpectedIsaAbsolute } from "../algorithm/isa/path-contract.ts"
import {
  contextPercentFromPayload,
  contextPercentFromTranscript,
  evaluateBudget,
} from "../policies/context-budget.ts"
import { loadRegenerateRules, matchRules } from "../policies/regenerate.ts"
import { expandPathMatchCandidates } from "../policies/path-utils.ts"
import {
  loadVerifyRules,
  loadVerifyRulesFromFile,
  runVerifyCommand,
  selectVerifyCommand,
  tailOf,
  verifyMapPathFor,
  type VerifyRule,
} from "../policies/verify-map.ts"
import { parseFrontmatter } from "../algorithm/isa/frontmatter.ts"
import { safeResolvePath } from "../services/path-resolution.ts"
import { logWarningSync } from "../services/diagnostics.ts"
import { runCommandLive, runShellCommandLive } from "../services/command-runner.ts"
import { logWarning } from "../services/diagnostics.ts"
import { reportHookFailure } from "../services/hook-failure.ts"
import { loadRuntimeConfig } from "../services/runtime-config.ts"
// D5: inspection-whitelist is lazy-loaded inside handleStop only. Keeping it
// out of the static import graph saves a small but real chunk of dispatcher
// cold-start time, which matters for the UserPromptSubmit p50 budget.
import type { loadInspectionWhitelist as LoadInspectionWhitelist } from "../policies/inspection-whitelist.ts"
/**
 * Load verify-map rules referenced by the active ISA's frontmatter field
 * `verify_map_path: <relative-path>`.
 *
 * Path resolution: `safeResolvePath` normalizes against `sessionRoot`,
 * collapses `..`, and realpath-resolves symlinks — but it does NOT
 * confine the result to sessionRoot. We enforce confinement here by
 * requiring the resolved absolute path to live under
 * `<sessionRoot>/.claude-hooks/` (the only place a per-task verify-map
 * legitimately belongs). Anything outside is rejected with a warn.
 *
 * Failure modes (all return []):
 *   - no active ISA on disk
 *   - frontmatter missing / unparseable
 *   - `verify_map_path` absent or non-string
 *   - resolved path escapes sessionRoot/.claude-hooks/
 *   - target file missing / oversized / malformed
 *
 * Extracted from the inline IIFE in handleStop so it's unit-testable.
 */
export const loadIsaVerifyRules = (
  sessionRoot: string,
  record: { readonly engagement_required?: boolean } & Parameters<
    typeof resolveActiveIsa
  >[0]["record"],
): ReadonlyArray<VerifyRule> => {
  const isaPath = resolveActiveIsa({ sessionRoot, record })
  if (isaPath === null || !existsSync(isaPath)) return []
  let isaContent: string
  try {
    isaContent = readFileSync(isaPath, "utf-8")
  } catch {
    return []
  }
  const fm = parseFrontmatter(isaContent)
  const ref = fm?.["verify_map_path"]
  if (typeof ref !== "string" || ref.length === 0) return []
  if (isAbsolute(ref) || win32.isAbsolute(ref)) {
    logWarningSync(
      `[verify-map] rejected absolute ISA verify_map_path; use a path relative to session root under .claude-hooks/: ${ref}`,
    )
    return []
  }
  const resolved = safeResolvePath(sessionRoot, ref)
  if (resolved === null) return []
  // Containment: must live under <sessionRoot>/.claude-hooks/.
  // safeResolvePath returns a realpath-normalized absolute path; we
  // compare against the realpath-normalized sessionRoot to avoid symlink
  // bypasses.
  const sessionRootResolved = safeResolvePath(sessionRoot, ".") ?? sessionRoot
  const allowedPrefix = sessionRootResolved.endsWith("/")
    ? `${sessionRootResolved}.claude-hooks/`
    : `${sessionRootResolved}/.claude-hooks/`
  if (!resolved.startsWith(allowedPrefix)) {
    logWarningSync(
      `[verify-map] rejected ISA verify_map_path escaping session root: ${ref} → ${resolved}`,
    )
    return []
  }
  return loadVerifyRulesFromFile(resolved)
}

const REGEN_TIMEOUT_MS = 10_000
// Total wall-clock budget the Stop handler is willing to spend. Sits under
// the dispatcher Stop cap (28_000 ms) and the installer's external 30_000 ms
// envelope. Verifier consumes up to 22_000 ms; regen rules are skipped when
// remaining budget is too small for their REGEN_TIMEOUT_MS.
const STOP_BUDGET_MS = 26_000

const BLOCK_REASON =
  "Code changed but no verification command has run. Run the smallest relevant test/typecheck now, then summarize the result."

const RESEARCH_BLOCK_REASON =
  "Source-backed answer is not ready: the source ledger has no fetched/recorded URLs for the current benchmark claims. Fetch or search the cited sources, record the URLs in session state, update the artifact/ISA with evidence-backed values, and state any remaining uncertainties. Do not satisfy this gate with a prose reconciliation alone."

const STATE_READ_BLOCK_REASON =
  "Hook state could not be read, so verification status is unknown. Re-run the smallest relevant verification command, then try Stop again."

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

const isPreIsaInspectionCommand = (
  cmd: string,
  extraWhitelist: ReadonlyArray<string> = [],
): boolean => {
  const trimmed = cmd.trim()
  if (hasUnquotedShellControl(trimmed)) return false
  if (trimmed === "pwd") return true
  if (isSafeRipgrepInspection(trimmed)) return true
  if (
    trimmed === "./bin/claude-hooks-workers list" ||
    trimmed === "./bin/claude-hooks-workers list --json"
  ) {
    return true
  }
  // D5: user-extended whitelist. Loader already filtered destructive entries;
  // we still match defensively — exact-string match OR prefix-match with
  // word boundary so `"git log"` accepts `git log --oneline` but not
  // `git logger`.
  for (const entry of extraWhitelist) {
    if (trimmed === entry) return true
    if (trimmed.startsWith(`${entry} `)) return true
  }
  return false
}

const isInspectionOnlyEngagement = (
  record: {
    readonly files_read: ReadonlyArray<string>
    readonly files_changed: ReadonlyArray<string>
    readonly commands_run: ReadonlyArray<string>
    readonly commands_failed: ReadonlyArray<string>
    readonly tests_run: ReadonlyArray<string>
    readonly subagent_starts: ReadonlyArray<string>
  },
  extraWhitelist: ReadonlyArray<string> = [],
): boolean =>
  (record.files_read.length > 0 ||
    record.commands_run.length > 0 ||
    record.subagent_starts.length > 0) &&
  record.files_changed.length === 0 &&
  record.commands_failed.length === 0 &&
  record.tests_run.length === 0 &&
  !record.subagent_starts.some((entry) => entry.endsWith(":worker-contract")) &&
  record.commands_run.every((cmd) => isPreIsaInspectionCommand(cmd, extraWhitelist))

const reportStateWriteFailure = (
  sessionId: string,
  op: string,
  cause: unknown,
): Effect.Effect<void> =>
  reportHookFailure({
    kind: "state_write_failed",
    event: "Stop",
    sessionId,
    cause,
    hookSafe: true,
    context: { op },
  })

const combineBlockReasons = (reasons: ReadonlyArray<string>): string => {
  if (reasons.length === 1) return reasons[0] ?? ""
  return [
    `Stop blocked by ${reasons.length} readiness issues:`,
    ...reasons.map((reason, i) => `${i + 1}. ${reason}`),
  ].join("\n\n")
}

/**
 * Stop handler.
 *
 * Loop protection is session-state driven inside this Effect handler.
 * `SessionState.stop_blocked_once` is deliberately scoped to the ISA-absence
 * reminder only. Source and verification readiness gates keep blocking until
 * the missing evidence is actually present; otherwise a first Stop block for
 * one readiness issue can mask a second unresolved issue later in the same
 * session.
 */
export const handleStop = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, SessionState> =>
  Effect.gen(function* () {
    if (payload._tag !== "Stop") return NO_DECISION
    const state = yield* SessionState
    const sid = payload.session_id
    const stateReadFallback: HookDecision = {
      decision: "block",
      reason: STATE_READ_BLOCK_REASON,
    }
    const recordEither = yield* Effect.either(state.get(sid))
    if (recordEither._tag === "Left") {
      yield* reportHookFailure({
        kind: "state_read_failed",
        event: "Stop",
        sessionId: sid,
        cause: recordEither.left,
        fallbackDecision: stateReadFallback,
        hookSafe: true,
        context: { op: "session-state.get" },
      })
      return stateReadFallback
    }
    const record = recordEither.right

    // ISA completeness gate — runs first because an ISA declaring
    // phase: complete with missing sections / unchecked ISCs is a
    // doctrine violation no other gate catches. IsaFormat.md:191-201.
    //
    // Distinguish two roots:
    //  - currentCwd: shell cwd at Stop time (mutable; may have drifted
    //    after Bash cd). Used for cwd-scoped policies (regenerate rules).
    //  - sessionRoot: frozen project root from engagement creation. Used
    //    for ISA lookup so cwd drift cannot hide the active artifact —
    //    Bash `cd ~/.claude/skills/foo` would otherwise make the gate
    //    look for ISAs under the skill directory.
    const currentCwd =
      typeof payload.cwd === "string" && payload.cwd.length > 0
        ? payload.cwd
        : process.cwd()
    const stopStartedAt = Date.now()
    const sessionRoot = record.session_root ?? currentCwd
    // D5: load user-extended inspection whitelist. Empty by default. The
    // loader rejects any destructive entry; we still bind the cwd-scoped
    // result here so it's threaded into every gate that calls
    // `isPreIsaInspectionCommand`.
    const inspectionMod = yield* Effect.promise(
      () =>
        import("../policies/inspection-whitelist.ts") as Promise<{
          loadInspectionWhitelist: typeof LoadInspectionWhitelist
        }>,
    )
    const inspectionWhitelistExtras =
      inspectionMod.loadInspectionWhitelist(sessionRoot)
    const preflightBlockReasons: string[] = []
    let shouldMarkStopBlockedOnce = false
    const isaVerdict = checkStopReadiness({ cwd: sessionRoot, record })
    if (isaVerdict._tag === "block") {
      preflightBlockReasons.push(isaVerdict.reason)
    }

    const runtimeConfig = yield* loadRuntimeConfig
    const contextPercent =
      contextPercentFromPayload(payload) ??
      contextPercentFromTranscript(payload.transcript_path)
    if (contextPercent !== null && runtimeConfig.contextBudgetThresholdPct > 0) {
      const activeIsaPath = resolveActiveIsa({ sessionRoot, record })
      let activeIsa: string | null = null
      if (activeIsaPath !== null && existsSync(activeIsaPath)) {
        try {
          activeIsa = readFileSync(activeIsaPath, "utf-8")
        } catch {
          activeIsa = null
        }
      }
      if (activeIsa !== null) {
        const budgetVerdict = evaluateBudget({
          contextPercent,
          threshold: runtimeConfig.contextBudgetThresholdPct,
          isa: activeIsa,
        })
        if (budgetVerdict._tag === "block") {
          preflightBlockReasons.push(budgetVerdict.reason)
        }
      }
    }

    // Source-required source-ledger gate.
    //
    // Keys off `requires_web_sources` (set by the prompt-router from a STRICT
    // web-source regex), NOT the loose `last_workflow` priming tag. This
    // applies to coding/build tasks too when the user explicitly asks for
    // current real data or cited sources.
    //
    // Opt-out: the active ISA can declare `source_ledger: not_applicable`
    // in frontmatter (read by post-edit-quality on ISA Write/Edit). When
    // set, this gate is suppressed for the rest of the session so pure-
    // code tasks whose prompts incidentally match WEB_SOURCES_REQUIRED
    // (e.g. "current best practices" in a UI build from a pasted spec)
    // can finish without a stale source-ledger block.
    if (
      record.requires_web_sources &&
      record.source_urls.length === 0 &&
      !record.source_ledger_opt_out
    ) {
      preflightBlockReasons.push(RESEARCH_BLOCK_REASON)
    }

    // Engagement absence gate — when ALGORITHM tier ≥ 3 was classified
    // upstream, the run MUST have produced an ISA. This participates in the
    // first-stop preflight bundle so a missing ISA cannot be masked by another
    // one-shot Stop gate such as missing sources.
    if (record.engagement_required && !record.stop_blocked_once) {
      // Session-scoped: a project ISA or the session's OWN expected ISA
      // satisfies the gate. A stale foreign-slug ISA under session_root
      // must NOT — that's the bug this resolver fixes.
      const activeIsa = resolveActiveIsa({ sessionRoot, record })
      const hasAnyIsa = activeIsa !== null && existsSync(activeIsa)
      if (!hasAnyIsa && !isInspectionOnlyEngagement(record, inspectionWhitelistExtras)) {
        const tierLabel =
          typeof record.last_tier === "number"
            ? `E${record.last_tier}`
            : "E3+"
        const expectedRel =
          record.expected_isa_path ?? "<.claude-hooks/work/<slug>/ISA.md>"
        // Surface the frozen absolute path alongside the relative one so
        // the model can write to it unambiguously even from a drifted cwd.
        const expectedAbs = resolveExpectedIsaAbsolute(sessionRoot, record)
        const expectedDisplay =
          expectedAbs !== null && expectedAbs !== expectedRel
            ? `\`${expectedRel}\` (absolute: \`${expectedAbs}\`)`
            : `\`${expectedRel}\``
        preflightBlockReasons.push(
          `ALGORITHM ${tierLabel} run is finishing without an ISA. ` +
            `Create it now at ${expectedDisplay} (or at \`<repo>/ISA.md\` if ` +
            `this is a project-level effort) with at minimum frontmatter ` +
            `(\`effort:\`, \`phase:\`), \`## Goal\`, and \`## Criteria\`. ` +
            `The downstream verification gates only fire on a real artifact; ` +
            `Stop will not block again on this session.`,
        )
        shouldMarkStopBlockedOnce = true
      }
    }

    // Verify-watermark: `verification_files` is the set of paths known-verified
    // by the most recent passing verify. The gate only treats a file as
    // unverified if it's in `files_changed` AND not in `verification_files`.
    // This prevents the cumulative `files_changed` list from re-arming the
    // gate forever after a successful verify — only files genuinely edited
    // since the last pass trigger another verify run.
    const verifiedSet = new Set(record.verification_files ?? [])
    const unverifiedFiles = record.files_changed.filter(
      (f) => !verifiedSet.has(f),
    )
    const hasUnverifiedFiles = unverifiedFiles.length > 0

    if (
      preflightBlockReasons.length > 0 &&
      record.files_changed.length > 0 &&
      hasUnverifiedFiles
    ) {
      preflightBlockReasons.push(BLOCK_REASON)
    }

    if (preflightBlockReasons.length > 0) {
      if (shouldMarkStopBlockedOnce) {
        yield* state
          .update(sid, { stop_blocked_once: true })
          .pipe(Effect.catchAll((cause) => reportStateWriteFailure(sid, "stop-blocked-once", cause)))
      }
      const out: HookDecision = {
        decision: "block",
        reason: combineBlockReasons(preflightBlockReasons),
      }
      return out
    }

    const filesChanged = record.files_changed.length
    // verify-map is a project-scoped policy (lives at
    // `<sessionRoot>/.claude-hooks/verify-map.yaml`), so rule loading,
    // glob-candidate expansion, and command execution must all root at
    // `sessionRoot` — not the drifted shell cwd. Using `currentCwd` here
    // diverged from the ISA gate (which uses sessionRoot) and caused
    // a self-perpetuating Stop loop when cwd != session_root.
    const verifyPathCandidates = expandPathMatchCandidates(
      sessionRoot,
      record.files_changed,
    )
    let verifiedThisStop = false
    if (filesChanged > 0 && hasUnverifiedFiles) {
      const repoRules = loadVerifyRules(sessionRoot)
      const isaRules = loadIsaVerifyRules(sessionRoot, record)
      if (isaRules.length > 0) {
        yield* logWarning(
          `[verify-map] loaded ${isaRules.length} rule(s) from ISA-referenced verify_map_path (session_root=${sessionRoot})`,
        )
      }
      // Additive concat: existing priority/specificity tiebreak in
      // selectVerifyCommand arbitrates conflicts across the combined list.
      const verifyRules = [...repoRules, ...isaRules]
      const selectedVerify = selectVerifyCommand(
        verifyPathCandidates,
        verifyRules,
      )
      if (selectedVerify !== null) {
        const cmdPreview = Array.isArray(selectedVerify.command)
          ? selectedVerify.command.join(" ")
          : selectedVerify.command
        yield* logWarning(
          `[verify-map] running (timeoutMs=${selectedVerify.timeoutMs}): ${cmdPreview.slice(0, 200)}${cmdPreview.length > 200 ? "..." : ""}`,
        )
        // runVerifyCommand is internally fault-tolerant: it converts
        // successful exits and command-runner failures into a
        // VerifyRunResult. If the runtime layer itself rejects,
        // unexpected exception), don't swallow silently — log the cause
        // and fall through to the reminder block.
        const result = yield* Effect.tryPromise({
          try: () => runVerifyCommand(selectedVerify, sessionRoot),
          catch: (cause) => new Error(String(cause)),
        }).pipe(
          Effect.tapError((cause) =>
            logWarning(`[verify-map] runner crashed: ${String(cause).slice(0, 200)}`),
          ),
          Effect.orElseSucceed(() => null),
        )

        if (result !== null) {
          const passed = result.exitCode === 0 && !result.timedOut
          // On pass: snapshot the current files_changed into verification_files
          // (union with the prior watermark so multiple partial-verify runs
          // accumulate). This is the gate's freshness anchor — subsequent
          // Stops with no new edits will see files_changed ⊆ verification_files
          // and skip the verify run entirely.
          const nextVerificationFiles = passed
            ? Array.from(
                new Set([
                  ...(record.verification_files ?? []),
                  ...record.files_changed,
                ]),
              )
            : (record.verification_files ?? [])
          yield* state
            .update(sid, {
              verification_status: passed ? "passed" : "failed",
              ...(passed ? { verification_files: nextVerificationFiles } : {}),
            })
            .pipe(Effect.catchAll((cause) => reportStateWriteFailure(sid, "verification-status", cause)))
          yield* state
            .append(
              sid,
              passed ? "tests_run" : "commands_failed",
              result.commandPreview,
            )
            .pipe(Effect.catchAll((cause) => reportStateWriteFailure(sid, "verification-command", cause)))

          if (passed) {
            verifiedThisStop = true
          } else {
            const tailSrc =
              result.stderr.length > 0 ? result.stderr : result.stdout
            const reasonHead = result.timedOut
              ? `Verification failed (timeout ${selectedVerify.timeoutMs}ms): ${result.commandPreview}`
              : `Verification failed (exit ${result.exitCode}): ${result.commandPreview}`
            const out: HookDecision = {
              decision: "block",
              reason: `${reasonHead}\n${tailOf(tailSrc, 1200)}`,
            }
            return out
          }
        }
      }
    }

    if (
      filesChanged > 0 &&
      hasUnverifiedFiles &&
      !verifiedThisStop
    ) {
      // D2: when no verify-map rule matched, tell the user (a) which paths
      // changed (sample) and (b) a concrete YAML stanza they can paste into
      // `.claude-hooks/verify-map.yaml` to fix it next time. Keeps the
      // generic guidance, just adds diagnostics.
      const sample = record.files_changed.slice(0, 3)
      const more = record.files_changed.length - sample.length
      const sampleLine =
        sample.length === 0
          ? ""
          : `\nChanged files (sample): ${sample.join(", ")}${more > 0 ? ` (+${more} more)` : ""}.`
      // D6: surface the absolute path the hook actually reads. The frozen
      // `session_root` can diverge from the user's mental model of "the
      // project" (e.g. when an early Bash `cd` shifted it before the first
      // engagement froze it). Without the absolute path here, the user can
      // edit the wrong `.claude-hooks/verify-map.yaml` for many turns
      // without realizing the hook is reading a different file.
      const verifyMapAbs = verifyMapPathFor(sessionRoot)
      const stanza =
        `\nAdd a rule to \`${verifyMapAbs}\`, e.g.:\n` +
        "rules:\n" +
        '  - source: "src/**/*.ts"\n' +
        '    command: "bun run typecheck"\n' +
        "    timeoutMs: 15000"
      const out: HookDecision = {
        decision: "block",
        reason: `${BLOCK_REASON}${sampleLine}${stanza}`,
      }
      return out
    }

    // 4b doc-integrity regen: best-effort run of declarative regenerate.yaml
    // rules whose `source` glob matched any file changed this session. Runs
    // AFTER all blocking gates pass so we don't waste regen work on a
    // session that's about to be blocked. Failures are logged, never block.
    const rules = loadRegenerateRules(currentCwd)
    const regenerateSkipped: string[] = []
    if (rules.length > 0 && record.files_changed.length > 0) {
      const regeneratePathCandidates = expandPathMatchCandidates(
        currentCwd,
        record.files_changed,
      )
      const matched = matchRules(regeneratePathCandidates, rules)
      for (const rule of matched) {
        const elapsed = Date.now() - stopStartedAt
        const remaining = STOP_BUDGET_MS - elapsed
        // Require REGEN_TIMEOUT_MS + 1s safety margin so a regen that
        // runs to its own timeout still leaves headroom for state I/O
        // and command-runner cleanup before we hit the dispatcher cap
        // (which would force the dispatcher to emit its hook-safe fallback).
        const REGEN_SAFETY_MARGIN_MS = 1_000
        if (remaining < REGEN_TIMEOUT_MS + REGEN_SAFETY_MARGIN_MS) {
          // D3: surface the silent skip. The warning stays (paper trail in
          // the diagnostics log); we ALSO collect the rule name into a
          // session-state marker so the NEXT UserPromptSubmit can inject
          // a heads-up into additionalContext.
          regenerateSkipped.push(rule.derived)
          yield* logWarning(
            `[regenerate] skipping ${rule.derived}: ${remaining}ms remaining, need ${REGEN_TIMEOUT_MS + REGEN_SAFETY_MARGIN_MS}ms`,
          )
          continue
        }
        // F6: log what we're about to run before execution so users have a paper
        // trail of what their regenerate.yaml is doing on their behalf.
        // Truncate the command preview at 160 chars to keep the line scannable.
        const cmdPreview = Array.isArray(rule.command)
          ? rule.command.join(" ")
          : rule.command
        yield* logWarning(
          `[regenerate] running for ${rule.derived}: ${cmdPreview.slice(0, 160)}${cmdPreview.length > 160 ? "..." : ""}`,
        )
        yield* Effect.tryPromise({
          try: async () => {
            const args = Array.isArray(rule.command)
              ? { cmd: rule.command[0] ?? "", argv: rule.command.slice(1) }
              : { cmd: "sh", argv: ["-c", rule.command as string] }
            if (args.cmd.length === 0) return
            const result = Array.isArray(rule.command)
              ? await runCommandLive(args.cmd, args.argv as string[], {
                  cwd: currentCwd,
                  timeoutMs: REGEN_TIMEOUT_MS,
                })
              : await runShellCommandLive(rule.command as string, {
                  cwd: currentCwd,
                  timeoutMs: REGEN_TIMEOUT_MS,
                })
            if (result.exitCode !== 0 || result.timedOut) {
              throw new Error(
                result.timedOut
                  ? `timeout ${REGEN_TIMEOUT_MS}ms`
                  : `exit ${result.exitCode}: ${result.stderr || result.stdout}`,
              )
            }
          },
          catch: (cause) => new Error(String(cause)),
        }).pipe(
          Effect.tapError((cause) =>
            logWarning(`[regenerate] ${rule.derived} failed: ${String(cause).slice(0, 200)}`),
          ),
          Effect.catchAll(() => Effect.succeed(undefined)),
        )
      }
    }

    // D3: persist skipped rule names so the next UserPromptSubmit can
    // surface them. Best-effort: a state-write failure must not block.
    if (regenerateSkipped.length > 0) {
      yield* state
        .update(sid, { regenerate_skipped: regenerateSkipped })
        .pipe(
          Effect.catchAll((cause) =>
            reportStateWriteFailure(sid, "regenerate-skipped", cause),
          ),
        )
    }

    return NO_DECISION
  })
