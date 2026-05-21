/**
 * The single sanctioned chokepoint for spawning the `claude` CLI from inside
 * this package. It delegates all process lifetime behavior to CommandRunner so
 * env scrubbing, timeout, stdout/stderr caps, and process cleanup remain
 * centralized.
 *
 * Why this file exists: Anthropic's credential precedence chain
 * (https://code.claude.com/docs/en/authentication#authentication-precedence)
 * puts BOTH `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` ABOVE
 * `CLAUDE_CODE_OAUTH_TOKEN`. If either is set in the spawned process's env,
 * it silently routes the work onto API-key billing instead of the user's
 * subscription — that's how this package principal got billed $498 in April 2026.
 *
 * Every spawn through `spawnClaude` always:
 * - deletes ANTHROPIC_API_KEY
 * - deletes ANTHROPIC_AUTH_TOKEN
 * - deletes CLAUDECODE (else nested-session guard rejects the spawn)
 *
 * A grep-based CI check (`scripts/check-claude-spawn.ts`) refuses to build
 * if any direct `Bun.spawn(["claude", ...])`, `child_process.spawn("claude",
 * ...)`, or `execFile("claude", ...)` appears anywhere in `src/` outside
 * this file. There is no second sanctioned path.
 */

import { Context, Effect, Layer } from "effect"
import { ShellError } from "../schema/errors.ts"
import { CommandRunner } from "./command-runner.ts"

export interface ClaudeSpawnOptions {
  /** Stdin payload (typically the user prompt). */
  readonly stdin: string
  /** Hard timeout in milliseconds. */
  readonly timeoutMs: number
  /** Optional cwd override. */
  readonly cwd?: string
  /** Additional sanitized environment for hook correlation. */
  readonly env?: Record<string, string | undefined>
}

export interface ClaudeSpawnResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly latencyMs: number
  readonly timedOut: boolean
}

export interface ClaudeSubprocessApi {
  /**
   * Spawn the `claude` CLI with the given args. Always uses the subscription
   * billing path (env scrub). Never throws — failure cases (timeout, non-zero
   * exit, spawn error) are returned as a result, not an Effect failure, so
   * callers can branch declaratively.
   */
  readonly spawn: (
    args: ReadonlyArray<string>,
    opts: ClaudeSpawnOptions,
  ) => Effect.Effect<ClaudeSpawnResult, ShellError>
}

export class ClaudeSubprocess extends Context.Tag("ClaudeSubprocess")<
  ClaudeSubprocess,
  ClaudeSubprocessApi
>() {}

/**
 * Pure env-scrubbing function. Exported for direct test coverage —
 * the assertion that scrubbing happens is the security-critical invariant.
 *
 * US-23 (2026-05-20): scrubbed keys are now MASKED with an empty string
 * rather than DROPPED from the record. Reason: Effect's
 * `Command.env(cmd, scrubbed)` merges `scrubbed` into the parent
 * `process.env` at spawn time (it doesn't replace wholesale). If we
 * dropped `CLAUDECODE` from the scrubbed record, the executor would
 * still inject `CLAUDECODE=1` from the parent shell. Emitting an
 * explicit empty string overrides the parent's value in the merge,
 * giving the child a defined-empty value the security claim depends on.
 *
 * Verified locally: with `CLAUDECODE=1` in the parent (the typical
 * Claude Code session env), spawn(child) without masking produces
 * `CLAUDECODE=1` in the child; with masking, the child sees
 * `CLAUDECODE=` (empty). The Anthropic key vars are masked the same
 * way — explicitly empty rather than possibly inherited.
 */
const SCRUB_TARGETS: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDECODE",
])

export const scrubClaudeEnv = (
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(source)) {
    if (typeof v !== "string") continue
    if (SCRUB_TARGETS.has(k)) {
      out[k] = "" // mask to override parent's value at spawn merge
      continue
    }
    out[k] = v
  }
  // Even if the source env didn't contain a scrub target, mask it
  // explicitly so the executor's parent-env merge can't introduce it
  // post-scrub. This is the actual security boundary — the source
  // env is whatever the caller passed; the parent env is the threat.
  for (const k of SCRUB_TARGETS) {
    if (!(k in out)) out[k] = ""
  }
  return out
}

export const ClaudeSubprocessLive = Layer.effect(
  ClaudeSubprocess,
  Effect.map(CommandRunner, (runner) =>
    ClaudeSubprocess.of({
      spawn: (args, opts) =>
        runner.run("claude", args, {
          ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
          ...(opts.env === undefined ? {} : { env: opts.env }),
          stdin: opts.stdin,
          timeoutMs: opts.timeoutMs,
          scrubEnv: scrubClaudeEnv,
        }).pipe(
          Effect.map((result) => ({
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            latencyMs: result.durationMs,
            timedOut: result.timedOut,
          })),
          Effect.mapError((cause) =>
            new ShellError({
              command: ["claude", ...args].join(" "),
              exitCode: cause.exitCode,
              stderr: cause.stderr,
              message: `claude-subprocess: ${cause.message}`,
            }),
          ),
        ),
    }),
  ),
)

/**
 * Test layer: the responder receives `args` and `opts`, returns whatever
 * the test wants the spawn to look like. Use this from any handler test
 * that exercises classifier paths so we never spawn a real claude in CI.
 */
export const ClaudeSubprocessTest = (
  responder: (
    args: ReadonlyArray<string>,
    opts: ClaudeSpawnOptions,
  ) => ClaudeSpawnResult = () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
    latencyMs: 0,
    timedOut: false,
  }),
): Layer.Layer<ClaudeSubprocess> =>
  Layer.succeed(
    ClaudeSubprocess,
    ClaudeSubprocess.of({
      spawn: (args, opts) => Effect.sync(() => responder(args, opts)),
    }),
  )
