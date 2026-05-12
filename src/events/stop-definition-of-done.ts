import { Effect } from "effect"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { promisify } from "node:util"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { SessionState } from "../services/session-state.ts"
import { findLatestISA, findProjectIsa } from "../algorithm/isa/locate.ts"
import { checkStopReadiness } from "../algorithm/isa/lifecycle.ts"
import { loadRegenerateRules, matchRules } from "../policies/regenerate.ts"

const execFileAsync = promisify(execFile)
const REGEN_TIMEOUT_MS = 10_000

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
    const record = yield* state
      .get(payload.session_id)
      .pipe(Effect.catchAll(() => Effect.succeed(null)))
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
    const sessionRoot = record.session_root ?? currentCwd
    const isaVerdict = checkStopReadiness({ cwd: sessionRoot, record })
    if (isaVerdict._tag === "block") {
      yield* state
        .update(payload.session_id, { stop_blocked_once: true })
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      const out: HookDecision = {
        decision: "block",
        reason: isaVerdict.reason,
      }
      return out
    }

    // Research-mode source-ledger gate
    const lw = record.last_workflow
    if (
      typeof lw === "string" &&
      lw.startsWith("research.") &&
      record.source_urls.length === 0
    ) {
      yield* state
        .update(payload.session_id, { stop_blocked_once: true })
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      const out: HookDecision = {
        decision: "block",
        reason: RESEARCH_BLOCK_REASON,
      }
      return out
    }

    const filesChanged = record.files_changed.length
    if (filesChanged > 0 && record.verification_status !== "passed") {
      yield* state
        .update(payload.session_id, { stop_blocked_once: true })
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
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
      const projectIsa = findProjectIsa(sessionRoot)
      const taskIsa = findLatestISA(sessionRoot)
      const hasAnyIsa =
        (projectIsa !== null && existsSync(projectIsa)) ||
        (taskIsa !== null && existsSync(taskIsa))
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
      const matched = matchRules(record.files_changed, rules)
      for (const rule of matched) {
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
