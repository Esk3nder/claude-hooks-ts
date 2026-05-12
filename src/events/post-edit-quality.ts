import { Effect } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { Project } from "../services/project.ts"
import { Shell } from "../services/shell.ts"
import { SessionState } from "../services/session-state.ts"
import { makeShellCommand } from "../schema/branded.ts"
import { isIsaFilePath } from "../algorithm/isa/locate.ts"
import { runCheckpoint } from "../algorithm/isa/checkpoint.ts"
import { handlePostToolUseIsaEffects } from "../algorithm/isa/lifecycle.ts"
import { Redact } from "../services/redact.ts"
import {
  buildFinding,
  coerceForScan,
  renderWarning,
  sliceForScan,
} from "../policies/content-scan.ts"

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "Update"])

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
  if (typeof input !== "object" || input === null) return null
  const fp = (input as { file_path?: unknown }).file_path
  return typeof fp === "string" ? fp : null
}

const formatterFor = (filePath: string): FormatterSpec | null => {
  const lower = filePath.toLowerCase()
  for (const entry of FORMATTERS) {
    if (entry.extensions.some((ext) => lower.endsWith(ext))) return entry.spec
  }
  return null
}

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
    if (payload._tag !== "PostToolUse") return SAFE_DEFAULT

    const file = filePathFromInput(payload.tool_input)
    const isEdit = EDIT_TOOLS.has(payload.tool_name)
    const isIsaEdit = isEdit && file !== null && isIsaFilePath(file)

    const state = yield* SessionState
    const sid = payload.session_id
    const record = yield* state
      .get(sid)
      .pipe(
        Effect.catchAll((cause) => {
          process.stderr.write(
            `[PostToolUse] session-state op=get failed: sid=${sid} cause=${String(cause).slice(0, 160)}\n`,
          )
          return Effect.succeed(null)
        }),
      )

    // Engaged-marker: when an ISA file is written, stamp `isa_engaged_at`
    // for telemetry. Do NOT clear `engagement_required` — the flag is
    // preserved as historical truth ("this session was supposed to
    // engage ISA"). Disk is the source of truth for whether the
    // PreToolUse gate releases (see policies/engagement-gate.ts).
    if (isIsaEdit) {
      yield* state
        .update(sid, {
          isa_engaged_at: new Date().toISOString(),
        })
        .pipe(
          Effect.catchAll((cause) => {
            process.stderr.write(
              `[PostToolUse] session-state op=isa-engaged-marker failed: sid=${sid} cause=${String(cause).slice(0, 160)}\n`,
            )
            return Effect.succeed(undefined)
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
        process.stderr.write(`${warning}\n`)
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
      yield* Effect.sync(() => {
        try {
          runCheckpoint(file, isaRoot)
        } catch (err) {
          process.stderr.write(
            `[checkpoint] uncaught: ${String(err)}\n`,
          )
        }
      })
      return SAFE_DEFAULT
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
    yield* handlePostToolUseIsaEffects(isaRoot, record ?? undefined)

    // Branch (b): formatter. Only runs when this was a file edit AND the
    // file isn't an ISA AND a formatter is registered for the extension.
    if (!isEdit) return SAFE_DEFAULT
    if (file === null) return SAFE_DEFAULT
    const fmt = formatterFor(file)
    if (fmt === null) return SAFE_DEFAULT
    const shell = yield* Shell
    void (yield* Project) // ensure Project is in the context for symmetry / future use

    // Probe availability
    const probeCmdE = makeShellCommand(fmt.probe.cmd, fmt.probe.args)
    if (probeCmdE._tag === "Left") return SAFE_DEFAULT
    const probe = yield* shell
      .run(probeCmdE.right, { timeoutMs: 1500 })
      .pipe(
        Effect.catchAll((cause: unknown) => {
          const msg = String(cause).slice(0, 120)
          process.stderr.write(
            `post-edit-quality: ${fmt.probe.cmd} failed silently: ${msg}\n`,
          )
          return Effect.succeed({ stdout: "", stderr: "", exitCode: -1 })
        }),
      )
    if (probe.exitCode !== 0) return SAFE_DEFAULT

    // Run formatter best-effort
    const runCmdE = makeShellCommand(fmt.run.cmd, fmt.run.args(file))
    if (runCmdE._tag === "Left") return SAFE_DEFAULT
    yield* shell
      .run(runCmdE.right, { timeoutMs: 5000 })
      .pipe(
        Effect.catchAll((cause: unknown) => {
          const msg = String(cause).slice(0, 120)
          process.stderr.write(
            `post-edit-quality: ${fmt.run.cmd} failed silently: ${msg}\n`,
          )
          return Effect.succeed({ stdout: "", stderr: "", exitCode: -1 })
        }),
      )
    return SAFE_DEFAULT
  })
