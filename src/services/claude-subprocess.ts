/**
 * The single sanctioned chokepoint for spawning the `claude` CLI from inside
 * this package. Mirrors `PAI/TOOLS/Inference.ts` lines 104-145 byte-for-byte
 * on env scrubbing, spawn library (node child_process), event-listener
 * accumulation, SIGTERM-on-timeout pattern, and result shape.
 *
 * Why this file exists: Anthropic's credential precedence chain
 * (https://code.claude.com/docs/en/authentication#authentication-precedence)
 * puts BOTH `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` ABOVE
 * `CLAUDE_CODE_OAUTH_TOKEN`. If either is set in the spawned process's env,
 * it silently routes the work onto API-key billing instead of the user's
 * subscription — that's how the PAI principal got billed $498 in April 2026.
 *
 * Every spawn through `spawnClaude` always:
 *   - deletes ANTHROPIC_API_KEY
 *   - deletes ANTHROPIC_AUTH_TOKEN
 *   - deletes CLAUDECODE     (else nested-session guard rejects the spawn)
 *
 * A grep-based CI check (`scripts/check-claude-spawn.ts`) refuses to build
 * if any direct `Bun.spawn(["claude", ...])`, `child_process.spawn("claude",
 * ...)`, or `execFile("claude", ...)` appears anywhere in `src/` outside
 * this file. There is no second sanctioned path.
 */

import { Context, Effect, Layer } from "effect"
import { spawn } from "node:child_process"
import { ShellError } from "../schema/errors.ts"

export interface ClaudeSpawnOptions {
  /** Stdin payload (typically the user prompt). */
  readonly stdin: string
  /** Hard timeout in milliseconds. */
  readonly timeoutMs: number
  /** Optional cwd override. */
  readonly cwd?: string
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
 */
export const scrubClaudeEnv = (
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(source)) {
    if (typeof v !== "string") continue
    if (k === "ANTHROPIC_API_KEY") continue
    if (k === "ANTHROPIC_AUTH_TOKEN") continue
    if (k === "CLAUDECODE") continue
    out[k] = v
  }
  return out
}

/**
 * Live impl mirroring PAI Inference.ts spawn pattern (lines 104-145):
 *   - node child_process.spawn (NOT Bun.spawn — match PAI exactly)
 *   - stdin written then ended
 *   - stdout/stderr accumulated via 'data' event listeners
 *   - timeout via setTimeout firing proc.kill('SIGTERM')
 *   - resolve on close, with success/error/exitCode mapped
 */
const liveImpl: ClaudeSubprocessApi = {
  spawn: (args, opts) =>
    Effect.tryPromise({
      try: async () =>
        new Promise<ClaudeSpawnResult>((resolve) => {
          const startedAt = Date.now()
          const env = scrubClaudeEnv(process.env)
          const proc = spawn("claude", [...args], {
            env,
            stdio: ["pipe", "pipe", "pipe"],
            ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          })

          let stdout = ""
          let stderr = ""
          let timedOut = false
          let resolved = false
          let sigkillTimer: NodeJS.Timeout | undefined

          /**
           * Detach all listeners so the proc handle is GC-eligible after we
           * resolve. Without this, a zombie process (one that ignores SIGTERM
           * AND SIGKILL — e.g. uninterruptible sleep on a network socket)
           * would keep the listener closures (and our captured `stdout`
           * buffers) alive for the lifetime of the parent process.
           */
          const detachListeners = (): void => {
            try { proc.stdout?.removeAllListeners() } catch { /* ignore */ }
            try { proc.stderr?.removeAllListeners() } catch { /* ignore */ }
            try { proc.removeAllListeners("close") } catch { /* ignore */ }
            try { proc.removeAllListeners("error") } catch { /* ignore */ }
          }

          const finish = (result: ClaudeSpawnResult): void => {
            if (resolved) return
            resolved = true
            if (sigkillTimer !== undefined) clearTimeout(sigkillTimer)
            detachListeners()
            resolve(result)
          }

          // Write stdin then close — mirrors PAI lines 142-144.
          if (proc.stdin) {
            try {
              if (opts.stdin.length > 0) proc.stdin.write(opts.stdin)
              proc.stdin.end()
            } catch {
              // Best-effort — close handler still fires.
            }
          }

          proc.stdout?.on("data", (data: Buffer) => {
            stdout += data.toString()
          })
          proc.stderr?.on("data", (data: Buffer) => {
            stderr += data.toString()
          })

          // Mirrors PAI lines 154-164: timeout fires SIGTERM AND resolves
          // immediately rather than waiting for the killed process to exit.
          // B5: schedule a SIGKILL fallback 1s after SIGTERM in case the
          // child ignores SIGTERM (e.g. caught and swallowed). The fallback
          // is fire-and-forget — we've already resolved with timedOut: true.
          const timeoutId = setTimeout(() => {
            timedOut = true
            try {
              proc.kill("SIGTERM")
            } catch {
              // ignore
            }
            sigkillTimer = setTimeout(() => {
              try {
                // B7 fix: `proc.killed` is true the moment ANY signal is
                // delivered (incl. an ignored SIGTERM) — checking it would
                // skip SIGKILL on the exact zombies we're trying to catch.
                // The right "still running" check is exitCode AND signalCode
                // both null: process hasn't exited and hasn't been
                // signal-terminated. Sending SIGKILL to an already-exited
                // PID could (rarely) hit a recycled PID, so skip when we
                // can confirm the process is gone.
                if (proc.exitCode === null && proc.signalCode === null) {
                  proc.kill("SIGKILL")
                }
              } catch {
                // ignore — process may already be gone
              }
            }, 1_000)
            // Don't keep the parent process alive waiting for the SIGKILL
            // timer if we're shutting down.
            if (typeof sigkillTimer.unref === "function") sigkillTimer.unref()
            finish({
              stdout,
              stderr,
              exitCode: -1,
              latencyMs: Date.now() - startedAt,
              timedOut: true,
            })
          }, opts.timeoutMs)

          // Mirrors PAI lines 166-178: on close, emit success or non-zero
          // exit. Time-out path already resolved above.
          proc.on("close", (code) => {
            clearTimeout(timeoutId)
            if (timedOut) return
            finish({
              stdout,
              stderr,
              exitCode: typeof code === "number" ? code : -1,
              latencyMs: Date.now() - startedAt,
              timedOut: false,
            })
          })

          proc.on("error", (err) => {
            clearTimeout(timeoutId)
            if (timedOut) return
            finish({
              stdout,
              stderr: stderr.length > 0 ? stderr : err.message,
              exitCode: -1,
              latencyMs: Date.now() - startedAt,
              timedOut: false,
            })
          })
        }),
      catch: (cause) =>
        new ShellError({
          command: ["claude", ...args].join(" "),
          exitCode: -1,
          stderr: "",
          message: `claude-subprocess: ${String(cause)}`,
        }),
    }),
}

export const ClaudeSubprocessLive = Layer.succeed(
  ClaudeSubprocess,
  ClaudeSubprocess.of(liveImpl),
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
