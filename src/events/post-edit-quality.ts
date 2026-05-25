import { Effect } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { NO_DECISION } from "../schema/decisions.ts"
import { Project } from "../services/project.ts"
import { Shell } from "../services/shell.ts"
import { SessionState, type VerificationStatus } from "../services/session-state.ts"
import { makeShellCommand } from "../schema/branded.ts"
import { isIsaFilePath } from "../algorithm/isa/locate.ts"
import { isVerifyMapPath } from "../policies/verify-map.ts"
import { isSessionHookOwnedPath } from "../policies/hook-owned-path.ts"
import { runCheckpoint } from "../algorithm/isa/checkpoint.ts"
import { mutablePathFromInput } from "../policies/write-class.ts"
import { handlePostToolUseIsaEffects } from "../algorithm/isa/lifecycle.ts"
import { parseFrontmatter } from "../algorithm/isa/frontmatter.ts"
import { readFileSync } from "node:fs"
import { Redact } from "../services/redact.ts"
import { logWarning } from "../services/diagnostics.ts"
import {
  buildFinding,
  coerceForScan,
  renderWarning,
  sliceForScan,
} from "../policies/content-scan.ts"
import {
  isSourceCollectionTool,
  isSuccessfulToolResponse,
  isUsableSourceToolResponse,
  isVerificationCommand,
  urlsFromToolInput,
  urlsFromToolResponse,
} from "../policies/tool-evidence.ts"

// Enforcement-plane P1 #5: NotebookEdit added so notebook writes
// also set files_changed and trigger Stop verification. Pre-fix,
// a notebook-only session never tripped the "files changed but no
// verification" gate. Matches WRITE_CLASS_TOOLS in write-class.ts.
const EDIT_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "Update",
  "NotebookEdit",
])

interface FormatterSpec {
  readonly probe: { cmd: string; args: ReadonlyArray<string> }
  readonly run: { cmd: string; args: (file: string) => ReadonlyArray<string> }
}

const FORMATTERS: ReadonlyArray<{
  readonly extensions: ReadonlyArray<string>
  readonly spec: FormatterSpec
}> = [
  {
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md"],
    spec: {
      probe: { cmd: "sh", args: ["-c", "command -v prettier >/dev/null 2>&1"] },
      run: {
        cmd: "prettier",
        args: (file) => ["--write", file],
      },
    },
  },
  {
    extensions: [".py"],
    spec: {
      probe: { cmd: "sh", args: ["-c", "command -v ruff >/dev/null 2>&1"] },
      run: { cmd: "ruff", args: (file) => ["format", file] },
    },
  },
  {
    extensions: [".rs"],
    spec: {
      probe: { cmd: "sh", args: ["-c", "command -v rustfmt >/dev/null 2>&1"] },
      run: { cmd: "rustfmt", args: (file) => [file] },
    },
  },
  {
    extensions: [".go"],
    spec: {
      probe: { cmd: "sh", args: ["-c", "command -v gofmt >/dev/null 2>&1"] },
      run: { cmd: "gofmt", args: (file) => ["-w", file] },
    },
  },
]

const filePathFromInput = (input: unknown): string | null => {
  // Enforcement-plane P1 #5: also read `notebook_path` for
  // NotebookEdit. Uses the canonical `mutablePathFromInput` helper
  // from `src/policies/write-class.ts` to stay in sync with the
  // pretool-policy write-path reducer.
  return mutablePathFromInput(input)
}

const commandFromInput = (input: unknown): string | null => {
  if (typeof input !== "object" || input === null) return null
  const c = (input as { command?: unknown }).command
  return typeof c === "string" ? c : null
}

const formatterFor = (filePath: string): FormatterSpec | null => {
  const lower = filePath.toLowerCase()
  for (const entry of FORMATTERS) {
    if (entry.extensions.some((ext) => lower.endsWith(ext))) return entry.spec
  }
  return null
}

const finishWithWarning = (warningContext: string | null): HookDecision =>
  warningContext === null
    ? NO_DECISION
    : {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: warningContext,
        },
      }

const recordSingleToolUseEvidence = (
  state: SessionState["Type"],
  payload: HookPayload,
  file: string | null,
  isEdit: boolean,
  sessionRoot: string | null,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (payload._tag !== "PostToolUse") return
    const response = (payload as { readonly tool_response?: unknown }).tool_response
    const success = isSuccessfulToolResponse(response)
    const entries: Array<{
      readonly key:
        | "files_changed"
        | "meta_artifacts_changed"
        | "commands_run"
        | "commands_failed"
        | "tests_run"
        | "source_urls"
      readonly value: string
    }> = []
    let verification: VerificationStatus = "none"
    let nextRequiredAction: string | null = null
    let shouldResetVerification = false
    // EP P2 #8: record the literal command that flipped verification
    // to passed/failed so a reviewer can audit which run counted.
    let verificationCommand: string | null = null

    // Hook meta-artifacts (ISA.md, .claude-hooks/verify-map.yaml) are
    // documentation OF verification, not code that needs verifying.
    // Recording them in `files_changed` creates a self-trap: the Stop
    // gate then demands verification, the model edits the ISA to add
    // verification evidence, and that edit re-enters `files_changed`,
    // looping indefinitely. Skip recording but otherwise treat the
    // edit as a no-op for evidence purposes.
    // Treat the active session's `.claude-hooks/` tree as hook-owned
    // bookkeeping: state JSON, work-dir artifacts, archives, etc. ISA
    // and verify-map already have named filters; this catches the rest
    // (e.g. a model repairing a corrupt state.json to escape a Stop
    // loop) so the repair doesn't itself feed the next loop. Scoped to
    // sessionRoot so foreign `.claude-hooks/` fixtures in test trees
    // remain real files_changed.
    const isMetaEdit =
      isEdit &&
      file !== null &&
      (isIsaFilePath(file) ||
        isVerifyMapPath(file, sessionRoot) ||
        isSessionHookOwnedPath(file, sessionRoot))

    // Verify-watermark eviction: if a non-meta edit re-touches a file that
    // was in the prior `verification_files` watermark, drop it so the next
    // Stop re-verifies. The Stop gate keys "unverified files" off the set
    // difference `files_changed \ verification_files`; without this eviction
    // a re-edit would slip past the gate.
    let evictFromWatermark: string | null = null
    if (isEdit && file !== null && success) {
      if (isMetaEdit) {
        entries.push({ key: "meta_artifacts_changed", value: file })
        nextRequiredAction = "Review or validate the hook meta-artifact change."
      } else {
        entries.push({ key: "files_changed", value: file })
        shouldResetVerification = true
        evictFromWatermark = file
        nextRequiredAction = "Run the smallest relevant test/typecheck for the changed files."
      }
    } else if (payload.tool_name === "Bash") {
      const cmd = commandFromInput(payload.tool_input)
      if (cmd !== null) {
        const hasResponse = response !== undefined && response !== null
        entries.push({ key: "commands_run", value: cmd })
        if (!success) entries.push({ key: "commands_failed", value: cmd })
        if (isVerificationCommand(cmd)) {
          entries.push({ key: "tests_run", value: cmd })
          verification = success && hasResponse ? "passed" : "failed"
          verificationCommand = cmd
          if (!success || !hasResponse) {
            if (success) entries.push({ key: "commands_failed", value: cmd })
            nextRequiredAction = "Read the failure output and fix the failing assertion."
          }
        } else if (!success) {
          nextRequiredAction = "Investigate the failed command before continuing."
        }
      }
    } else if (
      isSourceCollectionTool(payload.tool_name) &&
      isUsableSourceToolResponse(response)
    ) {
      for (const url of urlsFromToolInput(payload.tool_input)) {
        entries.push({ key: "source_urls", value: url })
      }
      for (const url of urlsFromToolResponse(response)) {
        entries.push({ key: "source_urls", value: url })
      }
    }

    if (entries.length > 0) {
      yield* state
        .appendBatch(payload.session_id, entries)
        .pipe(
          Effect.catchAll((cause) =>
            logWarning(
              `[PostToolUse] session-state op=append-evidence failed: sid=${payload.session_id} cause=${String(cause).slice(0, 160)}`,
            ),
          ),
        )
    }

    // Evict the re-edited file from the verify watermark so the Stop gate
    // re-treats it as unverified. Done as a separate read-modify-write so
    // it composes with the appendBatch above without growing a new schema
    // key for an eviction operation.
    if (evictFromWatermark !== null) {
      const evictTarget = evictFromWatermark
      yield* state
        .get(payload.session_id)
        .pipe(
          Effect.flatMap((r) => {
            const prior = r.verification_files ?? []
            if (!prior.includes(evictTarget)) return Effect.void
            const next = prior.filter((p) => p !== evictTarget)
            return state.update(payload.session_id, {
              verification_files: next,
            })
          }),
          Effect.catchAll((cause) =>
            logWarning(
              `[PostToolUse] session-state op=evict-watermark failed: sid=${payload.session_id} cause=${String(cause).slice(0, 160)}`,
            ),
          ),
        )
    }

    if (verification !== "none" || nextRequiredAction !== null) {
      // EP P2 #8: when verification flipped, compute the audit
      // metadata. verification_files is the intersection of
      // `files_changed` and entries the command mentions, where
      // "mentions" is a stem-match: strip the extension from the
      // changed file's basename and look for it surrounded by
      // word boundaries (path separator, dot, or whitespace) in the
      // command string. This catches the common companion-test
      // shape `src/foo.ts` <-> `test/foo.test.ts` (where the test
      // file's basename "foo.test.ts" doesn't contain "foo.ts" as
      // a literal substring). False-positive cost is low; the
      // field is record-only at P2.
      const matchesCommand = (path: string, cmd: string): boolean => {
        const basename = path.split("/").pop() ?? path
        // Match the full basename literally (catches `bun test path/to/file.ts`).
        if (cmd.includes(basename)) return true
        // Stem match: foo.ts -> foo; look for /foo. or \bfoo\b or .foo. etc.
        const stem = basename.replace(/\.[^./]+$/, "")
        if (stem.length === 0) return false
        const stemRe = new RegExp(
          `(?:^|[/\\s.])${stem.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}(?:[/\\s.]|$)`,
        )
        return stemRe.test(cmd)
      }
      // Union with the prior watermark so multiple partial-verify runs
      // accumulate. Replacing would lose paths verified by earlier runs.
      const verificationFiles =
        verification === "passed" && verificationCommand !== null
          ? yield* state.get(payload.session_id).pipe(
              Effect.map((r) => {
                const matched = r.files_changed.filter((p) =>
                  matchesCommand(p, verificationCommand!),
                )
                return Array.from(
                  new Set([...(r.verification_files ?? []), ...matched]),
                )
              }),
              Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<string>)),
            )
          : ([] as ReadonlyArray<string>)
      yield* state
        .update(payload.session_id, {
          ...(verification !== "none" || shouldResetVerification
            ? { verification_status: verification }
            : {}),
          next_required_action: nextRequiredAction,
          ...(verificationCommand !== null
            ? {
                verification_command: verificationCommand,
                verification_files: verificationFiles,
              }
            : {}),
        })
        .pipe(
          Effect.catchAll((cause) =>
            logWarning(
              `[PostToolUse] session-state op=verification-evidence failed: sid=${payload.session_id} cause=${String(cause).slice(0, 160)}`,
            ),
          ),
        )
    }
  })

/**
 * Two-branch handler:
 *   (a) Edit/Write of an ISA file → run checkpoint module (commits ISC
 *       transitions per allowlist). Does NOT run probes — probes that
 *       fired earlier already produced the ISA edit, so re-running here
 *       would just duplicate work and risk feedback loops.
 *   (b) Edit/Write of a non-ISA file (with a known formatter) → run
 *       formatter best-effort.
 *   (c) Any tool use (including non-edit tools): if probes are configured,
 *       run them against the latest ISA. Probe successes flip ISC
 *       checkboxes; that ISA edit fires PostToolUse next, where branch
 *       (a) commits.
 *
 * Branches compose: a single Edit on a non-ISA file runs (b) AND (c);
 * an Edit on an ISA file runs (a) only; a Bash command runs (c) only.
 */
export const handlePostToolUse = (
  payload: HookPayload,
): Effect.Effect<
  HookDecision,
  never,
  Project | Shell | Redact | SessionState
> =>
  Effect.gen(function* () {
    if (payload._tag !== "PostToolUse") return NO_DECISION

    const file = filePathFromInput(payload.tool_input)
    const isEdit = EDIT_TOOLS.has(payload.tool_name)
    const isIsaEdit = isEdit && file !== null && isIsaFilePath(file)
    let warningContext: string | null = null

    const state = yield* SessionState
    const sid = payload.session_id
    const record = yield* state
      .get(sid)
      .pipe(
        Effect.catchAll((cause) => {
          return logWarning(
            `[PostToolUse] session-state op=get failed: sid=${sid} cause=${String(cause).slice(0, 160)}`,
          ).pipe(Effect.as(null))
        }),
      )
    const sessionRoot =
      record?.session_root ??
      (typeof payload.cwd === "string" && payload.cwd.length > 0
        ? payload.cwd
        : null)

    yield* recordSingleToolUseEvidence(state, payload, file, isEdit, sessionRoot)

    // Engaged-marker: when an ISA file is written, stamp `isa_engaged_at`
    // for telemetry. Do NOT clear `engagement_required` — the flag is
    // preserved as historical truth ("this session was supposed to
    // engage ISA"). Disk is the source of truth for whether the
    // PreToolUse gate releases (see policies/engagement-gate.ts).
    if (isIsaEdit) {
      // Source-ledger opt-out: when the ISA frontmatter declares
      // `source_ledger: not_applicable`, set the session-state flag so
      // the Stop research-mode gate suppresses its source-ledger block.
      // Opt-IN: the flag never flips back to true on its own; an ISA
      // edit that REMOVES the declaration clears the flag. Best-effort:
      // a read error keeps the previous flag value unchanged.
      let optOut: boolean | undefined = undefined
      if (file !== null) {
        try {
          const content = readFileSync(file, "utf-8")
          const fm = parseFrontmatter(content)
          if (fm !== null) {
            const v = (fm["source_ledger"] ?? "").toLowerCase().trim()
            optOut = v === "not_applicable"
          }
        } catch {
          // best-effort: leave optOut undefined
        }
      }
      yield* state
        .update(sid, {
          isa_engaged_at: new Date().toISOString(),
          ...(optOut === undefined ? {} : { source_ledger_opt_out: optOut }),
        })
        .pipe(
          Effect.catchAll((cause) => {
            return logWarning(
              `[PostToolUse] session-state op=isa-engaged-marker failed: sid=${sid} cause=${String(cause).slice(0, 160)}`,
            )
          }),
        )
    }

    // 4a content-scan: scan tool_response for secret patterns. Report-only
    // by default — emits an additionalContext warning so the model treats
    // the output as sensitive. Runs FIRST because subsequent branches may
    // act on the same payload (formatter, probes); we want the scan
    // verdict regardless of which branch fires.
    //
    // F1 fix: SLICE BEFORE detect. Previously we passed the untruncated
    // payload to redact.containsSecret, so a 100MB Read response would
    // regex-pin the dispatcher even though the 64KB cap was supposedly
    // enforced. The cap only protected scanFinding.scannedBytes — the
    // detection itself ran on the full text. Now we slice first.
    const redact = yield* Redact
    const responseText = (payload as { tool_response?: unknown }).tool_response
    const coerced = coerceForScan(responseText)
    if (coerced.length > 0) {
      const sliced = sliceForScan(coerced)
      const containsSecret = yield* redact.containsSecret(sliced.text)
      const scanFinding = buildFinding({
        field: "tool_response",
        text: sliced.text,
        truncated: sliced.truncated,
        secretDetected: containsSecret,
      })
      if (scanFinding.secretDetected) {
        const warning = renderWarning(scanFinding)
        warningContext = warning
        yield* logWarning(warning)
        // Continue with branches — scan is report-only.
      }
    }

    // ISA-rooted operations use the session's frozen `session_root` (set
    // by the engagement gate at UserPromptSubmit) so a Bash `cd` after
    // engagement doesn't move our view of the active ISA. Falls back to
    // payload.cwd / process.cwd() when state has no frozen root yet
    // (pre-engagement sessions).
    const isaRoot =
      record?.session_root ??
      (typeof payload.cwd === "string" && payload.cwd.length > 0
        ? payload.cwd
        : process.cwd())

    // Branch (a): Edit/Write on an ISA file → checkpoint, no probes, no formatter.
    if (isIsaEdit && file !== null) {
      yield* Effect.tryPromise({
        try: async () => {
          await runCheckpoint(file, isaRoot)
        },
        catch: (err) => new Error(String(err)),
      }).pipe(
        Effect.tapError((err) => logWarning(`[checkpoint] uncaught: ${String(err)}`)),
        Effect.catchAll(() => Effect.succeed(undefined)),
      )
      return finishWithWarning(warningContext)
    }

    // Branch (c): probes — run against latest ISA on EVERY non-ISA-edit
    // PostToolUse, including non-edit tools (Bash, Read, etc.). Non-blocking.
    //
    // The parse → probe → flip → checkpoint sequence lives behind the
    // lifecycle façade (`handlePostToolUseIsaEffects`). It keeps the flip
    // and checkpoint atomic to prevent the historical F3-style
    // flip-without-commit class of bug — when probes flip a checkbox via
    // hook-side writeFileSync, no PostToolUse fires, so the façade must
    // run checkpoint inline.
    // Pass the session record so probe targeting honors session-scoped
    // ISA identity (a stale foreign-slug ISA under session_root must NOT
    // be flipped by the current session's probe runner).
    // US-14: collect ISC ids that probes actually flipped this round so
    // the Stop completeness gate can distinguish probe-verified from
    // model-asserted checkboxes. Append happens AFTER the effect runs to
    // keep handlePostToolUseIsaEffects sync-callback-friendly.
    //
    // ORDERING INVARIANT: this append MUST happen before the next ISA
    // PostToolUse event fires. The probe-flip path inside
    // handlePostToolUseIsaEffects writes `[x]` to the ISA file, which
    // triggers a follow-on PostToolUse event for that ISA edit. If the
    // append were deferred (e.g., moved after the formatter branch
    // below), the follow-on ISA-edit event could take the `isIsaEdit`
    // branch and the appender for THIS flip would never run, breaking
    // the provenance contract. Keep the append immediately after the
    // probe runner; do NOT move it past any other effectful step.
    const probeFlippedIscs: string[] = []
    yield* handlePostToolUseIsaEffects(isaRoot, record ?? undefined, {
      onProbeFlipped: (iscId) => {
        probeFlippedIscs.push(iscId)
      },
    })
    if (probeFlippedIscs.length > 0) {
      const state = yield* SessionState
      for (const iscId of probeFlippedIscs) {
        yield* state
          .append(payload.session_id, "probe_verified_iscs", iscId)
          .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      }
    }

    // Branch (b): formatter. Only runs when this was a file edit AND the
    // file isn't an ISA AND a formatter is registered for the extension.
    if (!isEdit) return finishWithWarning(warningContext)
    if (file === null) return finishWithWarning(warningContext)
    const fmt = formatterFor(file)
    if (fmt === null) return finishWithWarning(warningContext)
    const shell = yield* Shell
    void (yield* Project) // ensure Project is in the context for symmetry / future use

    // Probe availability
    const probeCmdE = makeShellCommand(fmt.probe.cmd, fmt.probe.args)
    if (probeCmdE._tag === "Left") return finishWithWarning(warningContext)
    const probe = yield* shell
      .run(probeCmdE.right, { timeoutMs: 1500 })
      .pipe(
        Effect.catchAll((cause: unknown) => {
          const msg = String(cause).slice(0, 120)
          return logWarning(
            `post-edit-quality: ${fmt.probe.cmd} failed; continuing: ${msg}`,
          ).pipe(Effect.as({ stdout: "", stderr: "", exitCode: -1 }))
        }),
      )
    if (probe.exitCode !== 0) return finishWithWarning(warningContext)

    // Run formatter best-effort
    const runCmdE = makeShellCommand(fmt.run.cmd, fmt.run.args(file))
    if (runCmdE._tag === "Left") return finishWithWarning(warningContext)
    yield* shell
      .run(runCmdE.right, { timeoutMs: 5000 })
      .pipe(
        Effect.catchAll((cause: unknown) => {
          const msg = String(cause).slice(0, 120)
          return logWarning(
            `post-edit-quality: ${fmt.run.cmd} failed; continuing: ${msg}`,
          ).pipe(Effect.as({ stdout: "", stderr: "", exitCode: -1 }))
        }),
      )
    return finishWithWarning(warningContext)
  })
