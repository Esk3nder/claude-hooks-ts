import { Effect } from "effect"
import { readFileSync, existsSync, writeFileSync } from "node:fs"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { Project } from "../services/project.ts"
import { Shell } from "../services/shell.ts"
import { SessionState } from "../services/session-state.ts"
import { makeShellCommand } from "../schema/branded.ts"
import {
  isIsaFilePath,
  findLatestISA,
  findProjectIsa,
} from "../algorithm/isa/locate.ts"
import { runCheckpoint } from "../algorithm/isa/checkpoint.ts"
import { parseSections } from "../algorithm/isa/sections.ts"
import { parseCriteriaList } from "../algorithm/isa/criteria.ts"
import {
  loadProbes,
  matchProbes,
  parseTestStrategy,
  probesPathFor,
  resolveProbe,
  runProbe,
} from "../algorithm/isa/probes.ts"
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
 * Flip an ISC's `[ ]` checkbox to `[x]` in-place. Returns true on success
 * (a flip was actually performed), false if the line was already checked
 * or the criterion line wasn't found. Idempotent.
 *
 * Used by the probe-runner branch — when a probe passes for a pending ISC,
 * we edit the ISA so checkpoint.ts can pick up the transition on the next
 * PostToolUse event.
 */
const flipIscCheckbox = (isaPath: string, iscId: string): boolean => {
  if (!existsSync(isaPath)) return false
  let content: string
  try {
    content = readFileSync(isaPath, "utf-8")
  } catch {
    return false
  }
  // Match a `- [ ]` line whose ID is exactly `iscId`. Word-boundary on the
  // ID prevents `ISC-1` from matching `ISC-1.2` or `ISC-12`.
  const escaped = iscId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(`^(- \\[) (\\]\\s*${escaped}\\b)`, "m")
  if (!re.test(content)) return false
  const next = content.replace(re, "$1x$2")
  if (next === content) return false
  try {
    writeFileSync(isaPath, next, "utf-8")
    return true
  } catch (err) {
    process.stderr.write(`[probes] failed to flip ${iscId}: ${String(err)}\n`)
    return false
  }
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

    // Engaged-marker: when an ISA file is written, stamp `isa_engaged_at`
    // for telemetry. Do NOT clear `engagement_required` — the flag is
    // preserved as historical truth ("this session was supposed to
    // engage ISA"). Disk is the source of truth for whether the
    // PreToolUse gate releases (see policies/engagement-gate.ts).
    if (isIsaEdit) {
      const state = yield* SessionState
      yield* state
        .update(payload.session_id, {
          isa_engaged_at: new Date().toISOString(),
        })
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
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

    // Branch (a): Edit/Write on an ISA file → checkpoint, no probes, no formatter.
    if (isIsaEdit && file !== null) {
      yield* Effect.sync(() => {
        try {
          runCheckpoint(file)
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
    // F5 fix: cheap existsSync gate FIRST. Common case (no probes file)
    // skips the ISA scan + parse + section walk entirely, saving real
    // I/O on every PostToolUse.
    //
    // F3 fix: probe-flipped ISCs were dead-letters — hook-side writeFileSync
    // does NOT fire PostToolUse (only model tool calls do), so checkpoint
    // never saw the transition. We now call runCheckpoint explicitly after
    // any flip so the auto-commit actually happens.
    yield* Effect.tryPromise({
      try: async () => {
        if (!existsSync(probesPathFor())) return
        // Prefer the most-recent state/work/<slug>/ISA.md, but fall back to
        // <root>/ISA.md — the second canonical home per IsaFormat.md
        // lines 56-57. Without this fallback, project-root ISAs (the form
        // the README documents) are invisible to the probe runner even
        // though the doctor and TaskCompleted/Stop gates find them fine.
        const isa = findLatestISA() ?? findProjectIsa()
        if (isa === null) return
        if (!existsSync(isa)) return
        const content = readFileSync(isa, "utf-8")
        const criteria = parseCriteriaList(content)
        if (criteria.length === 0) return
        const sections = parseSections(content)
        const tsBody = sections.get("Test Strategy")?.body ?? ""
        if (tsBody.length === 0) return
        const strategyMap = parseTestStrategy(tsBody)
        if (strategyMap.size === 0) return
        const registry = await loadProbes()
        if (Object.keys(registry).length === 0) return
        const matches = matchProbes(
          criteria,
          strategyMap,
          registry,
          (miss) => {
            const known =
              miss.registeredNames.length === 0
                ? "registry is empty"
                : `registry has [${miss.registeredNames.join(", ")}]`
            process.stderr.write(
              `[probes] ${miss.iscId} declares probe '${miss.probeName}' but ${known} — check that probes.ts exports a key matching the ISA's 'tool' column\n`,
            )
          },
        )
        let anyFlipped = false
        for (const m of matches) {
          const { fn, timeoutMs } = resolveProbe(m.probe)
          const passed = await Effect.runPromise(
            runProbe(fn, m.criterion, timeoutMs),
          )
          if (passed && flipIscCheckbox(isa, m.criterion.id)) {
            anyFlipped = true
          }
        }
        if (anyFlipped) {
          try {
            runCheckpoint(isa)
          } catch (err) {
            process.stderr.write(
              `[probes] post-flip checkpoint failed: ${String(err)}\n`,
            )
          }
        }
      },
      catch: (cause) => {
        process.stderr.write(`[probes] uncaught: ${String(cause)}\n`)
        return new Error(String(cause))
      },
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

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
