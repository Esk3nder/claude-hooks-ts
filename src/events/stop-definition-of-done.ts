import { Effect } from "effect"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { promisify } from "node:util"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { SessionState } from "../services/session-state.ts"
import { checkStopReadiness, resolveActiveIsa } from "../algorithm/isa/lifecycle.ts"
import { loadRegenerateRules, matchRules } from "../policies/regenerate.ts"
import { expandPathMatchCandidates } from "../policies/path-utils.ts"
import {
  loadVerifyRules,
  runVerifyCommand,
  selectVerifyCommand,
  tailOf,
} from "../policies/verify-map.ts"

const execFileAsync = promisify(execFile)
const REGEN_TIMEOUT_MS = 10_000
// Total wall-clock budget the Stop handler is willing to spend. Sits under
// the dispatcher Stop cap (28_000 ms) and the installer's external 30_000 ms
// envelope. Verifier consumes up to 22_000 ms; regen rules are skipped when
// remaining budget is too small for their REGEN_TIMEOUT_MS.
const STOP_BUDGET_MS = 26_000

const BLOCK_REASON =
  "Code changed but no verification command has run. Run the smallest relevant test/typecheck now, then summarize the result."

const RESEARCH_BLOCK_REASON =
  "Research answer is not ready: source ledger has unsupported claims. Reconcile claims to sources and state uncertainties before final response."

/**
 * Stop handler.
 *
 * Loop-protection note: the official Claude Code Stop event payload does NOT
 * carry a `stop_hook_active` field (despite earlier docs/community examples).
 * We instead rely on `SessionState.stop_blocked_once` — once a session has
 * blocked one Stop, the next Stop in that session is allowed through to
 * avoid an infinite block loop.
 */
export const handleStop = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, SessionState> =>
  Effect.gen(function* () {
    if (payload._tag !== "Stop") return SAFE_DEFAULT
    const state = yield* SessionState
    const sid = payload.session_id
    const record = yield* state
      .get(sid)
      .pipe(
        Effect.catchAll((cause) => {
          process.stderr.write(
            `[Stop] session-state op=get failed: sid=${sid} cause=${String(cause).slice(0, 160)}\n`,
          )
          return Effect.succeed(null)
        }),
      )
    if (record === null) return SAFE_DEFAULT
    // Local loop-guard: never block twice in the same session.
    if (record.stop_blocked_once) return SAFE_DEFAULT

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
    const isaVerdict = checkStopReadiness({ cwd: sessionRoot, record })
    if (isaVerdict._tag === "block") {
      yield* state
        .update(sid, { stop_blocked_once: true })
        .pipe(
          Effect.catchAll((cause) => {
            process.stderr.write(
              `[Stop] session-state op=stop-blocked-once failed: sid=${sid} cause=${String(cause).slice(0, 160)}\n`,
            )
            return Effect.succeed(undefined)
          }),
        )
      const out: HookDecision = {
        decision: "block",
        reason: isaVerdict.reason,
      }
      return out
    }

    // Research-mode source-ledger gate.
    //
    // Keys off `requires_web_sources` (set by the prompt-router from a STRICT
    // web-research regex), NOT the loose `last_workflow` priming tag. Prior
    // behavior gated whenever `last_workflow.startsWith("research.")`, which
    // included `research.repo` ("find the function") and `research.synthesis`
    // ("compare X and Y") — neither warrants a source-URL ledger — and also
    // fired on a bare `latest` keyword in the priming regex (e.g. "are we on
    // the latest"). The new boolean is set only by `requiresWebSources` in
    // policies/workflow-classifier.ts.
    if (record.requires_web_sources && record.source_urls.length === 0) {
      yield* state
        .update(sid, { stop_blocked_once: true })
        .pipe(
          Effect.catchAll((cause) => {
            process.stderr.write(
              `[Stop] session-state op=stop-blocked-once failed: sid=${sid} cause=${String(cause).slice(0, 160)}\n`,
            )
            return Effect.succeed(undefined)
          }),
        )
      const out: HookDecision = {
        decision: "block",
        reason: RESEARCH_BLOCK_REASON,
      }
      return out
    }

    const filesChanged = record.files_changed.length
    const changedPathCandidates = expandPathMatchCandidates(
      currentCwd,
      record.files_changed,
    )
    let verifiedThisStop = false
    if (filesChanged > 0 && record.verification_status !== "passed") {
      const verifyRules = loadVerifyRules(currentCwd)
      const selectedVerify = selectVerifyCommand(
        changedPathCandidates,
        verifyRules,
      )
      if (selectedVerify !== null) {
        const cmdPreview = Array.isArray(selectedVerify.command)
          ? selectedVerify.command.join(" ")
          : selectedVerify.command
        process.stderr.write(
          `[verify-map] running (timeoutMs=${selectedVerify.timeoutMs}): ${cmdPreview.slice(0, 200)}${cmdPreview.length > 200 ? "..." : ""}\n`,
        )
        // runVerifyCommand is internally fault-tolerant — it converts
        // both successful exits and Node `execFile` errors into a
        // VerifyRunResult, so this Effect should never fail. But if the
        // runtime layer itself rejects (effect scheduler issue,
        // unexpected exception), don't swallow silently — log the cause
        // and fall through to the reminder block.
        const result = yield* Effect.tryPromise({
          try: () => runVerifyCommand(selectedVerify, currentCwd),
          catch: (cause) => new Error(String(cause)),
        }).pipe(
          Effect.tapError((cause) =>
            Effect.sync(() => {
              process.stderr.write(
                `[verify-map] runner crashed: ${String(cause).slice(0, 200)}\n`,
              )
            }),
          ),
          Effect.orElseSucceed(() => null),
        )

        if (result !== null) {
          const passed = result.exitCode === 0 && !result.timedOut
          yield* state
            .update(sid, {
              verification_status: passed ? "passed" : "failed",
            })
            .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
          yield* state
            .append(
              sid,
              passed ? "tests_run" : "commands_failed",
              result.commandPreview,
            )
            .pipe(Effect.catchAll(() => Effect.succeed(undefined)))

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
      record.verification_status !== "passed" &&
      !verifiedThisStop
    ) {
      yield* state
        .update(sid, { stop_blocked_once: true })
        .pipe(
          Effect.catchAll((cause) => {
            process.stderr.write(
              `[Stop] session-state op=stop-blocked-once failed: sid=${sid} cause=${String(cause).slice(0, 160)}\n`,
            )
            return Effect.succeed(undefined)
          }),
        )
      const out: HookDecision = {
        decision: "block",
        reason: BLOCK_REASON,
      }
      return out
    }

    // Engagement absence gate (last among blocking gates) — when ALGORITHM
    // tier ≥ 3 was classified upstream, the run MUST have produced an ISA.
    // Absence is the failure mode the prompt-router engagement directive
    // is designed to prevent; here we make it a real gate instead of a hint.
    // Runs LAST so workflow-specific gates (research source-ledger, files-
    // changed-without-verification) get to fire on their own more-actionable
    // reasons first; this gate is the doctrinal fallback. Fires once per
    // session via stop_blocked_once.
    if (record.engagement_required) {
      // Session-scoped: a project ISA or the session's OWN expected ISA
      // satisfies the gate. A stale foreign-slug ISA under session_root
      // must NOT — that's the bug this resolver fixes.
      const activeIsa = resolveActiveIsa({ sessionRoot, record })
      const hasAnyIsa = activeIsa !== null && existsSync(activeIsa)
      if (!hasAnyIsa) {
        yield* state
          .update(payload.session_id, { stop_blocked_once: true })
          .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
        const tierLabel =
          typeof record.last_tier === "number"
            ? `E${record.last_tier}`
            : "E3+"
        const expectedRel =
          record.expected_isa_path ?? "<.claude-hooks/work/<slug>/ISA.md>"
        // Surface the frozen absolute path alongside the relative one so
        // the model can write to it unambiguously even from a drifted cwd.
        const expectedAbs = record.expected_isa_path_absolute
        const expectedDisplay =
          expectedAbs !== null && expectedAbs !== expectedRel
            ? `\`${expectedRel}\` (absolute: \`${expectedAbs}\`)`
            : `\`${expectedRel}\``
        const out: HookDecision = {
          decision: "block",
          reason:
            `ALGORITHM ${tierLabel} run is finishing without an ISA. ` +
            `Create it now at ${expectedDisplay} (or at \`<repo>/ISA.md\` if ` +
            `this is a project-level effort) with at minimum frontmatter ` +
            `(\`effort:\`, \`phase:\`), \`## Goal\`, and \`## Criteria\`. ` +
            `The downstream verification gates only fire on a real artifact; ` +
            `Stop will not block again on this session.`,
        }
        return out
      }
    }

    // 4b doc-integrity regen: best-effort run of declarative regenerate.yaml
    // rules whose `source` glob matched any file changed this session. Runs
    // AFTER all blocking gates pass so we don't waste regen work on a
    // session that's about to be blocked. Failures are logged, never block.
    const rules = loadRegenerateRules(currentCwd)
    if (rules.length > 0 && record.files_changed.length > 0) {
      const matched = matchRules(changedPathCandidates, rules)
      for (const rule of matched) {
        const elapsed = Date.now() - stopStartedAt
        const remaining = STOP_BUDGET_MS - elapsed
        // Require REGEN_TIMEOUT_MS + 1s safety margin so a regen that
        // runs to its own timeout still leaves headroom for state I/O
        // and the SIGTERM/exit handshake before we hit the dispatcher
        // cap (which would turn our decision into SAFE_DEFAULT).
        const REGEN_SAFETY_MARGIN_MS = 1_000
        if (remaining < REGEN_TIMEOUT_MS + REGEN_SAFETY_MARGIN_MS) {
          process.stderr.write(
            `[regenerate] skipping ${rule.derived}: ${remaining}ms remaining, need ${REGEN_TIMEOUT_MS + REGEN_SAFETY_MARGIN_MS}ms\n`,
          )
          continue
        }
        // F6: log what we're about to run BEFORE exec so users have a paper
        // trail of what their regenerate.yaml is doing on their behalf.
        // Truncate the command preview at 160 chars to keep the line scannable.
        const cmdPreview = Array.isArray(rule.command)
          ? rule.command.join(" ")
          : rule.command
        process.stderr.write(
          `[regenerate] running for ${rule.derived}: ${cmdPreview.slice(0, 160)}${cmdPreview.length > 160 ? "..." : ""}\n`,
        )
        yield* Effect.tryPromise({
          try: async () => {
            const args = Array.isArray(rule.command)
              ? { cmd: rule.command[0] ?? "", argv: rule.command.slice(1) }
              : { cmd: "sh", argv: ["-c", rule.command as string] }
            if (args.cmd.length === 0) return
            await execFileAsync(args.cmd, args.argv as string[], {
              cwd: currentCwd,
              timeout: REGEN_TIMEOUT_MS,
            })
          },
          catch: (cause) => {
            process.stderr.write(
              `[regenerate] ${rule.derived} failed: ${String(cause).slice(0, 200)}\n`,
            )
            return new Error(String(cause))
          },
        }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      }
    }

    return SAFE_DEFAULT
  })
