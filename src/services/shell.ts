import { Context, Effect, Layer } from "effect"
import { ShellError } from "../schema/errors.ts"
import { currentProcessEnv } from "../bootstrap/env.ts"
import type { ShellCommand } from "../schema/branded.ts"

export interface ShellResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface ShellApi {
  readonly run: (
    cmd: ShellCommand,
    opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
  ) => Effect.Effect<ShellResult, ShellError>
}

export class Shell extends Context.Tag("Shell")<Shell, ShellApi>() {}

export const ShellLive = Layer.succeed(
  Shell,
  Shell.of({
    run: (cmd, opts) =>
      Effect.tryPromise({
        try: async () => {
          const spawnOpts: Parameters<typeof Bun.spawn>[1] = {
            stdout: "pipe",
            stderr: "pipe",
          }
          if (opts?.cwd !== undefined) spawnOpts.cwd = opts.cwd
          if (opts?.env !== undefined)
            spawnOpts.env = { ...currentProcessEnv(), ...opts.env } as Record<string, string>
          const proc = Bun.spawn(
            ["sh", "-c", cmd as unknown as string],
            spawnOpts,
          )

          // Honor caller-supplied timeoutMs. Without this, a hung child (e.g. a
          // formatter that blocks on a TTY) would pin the dispatcher past its
          // per-tag cap. On timeout: SIGTERM, then SIGKILL 1s later if still
          // alive, return exitCode=-1 with a marker stderr so callers can
          // distinguish from normal non-zero exits.
          const timeoutMs = opts?.timeoutMs
          let timedOut = false
          let timeoutId: ReturnType<typeof setTimeout> | undefined
          let killTimer: ReturnType<typeof setTimeout> | undefined
          if (typeof timeoutMs === "number" && timeoutMs > 0) {
            timeoutId = setTimeout(() => {
              timedOut = true
              try { proc.kill("SIGTERM") } catch { /* ignore */ }
              killTimer = setTimeout(() => {
                try { proc.kill("SIGKILL") } catch { /* ignore */ }
              }, 1_000)
              if (typeof killTimer.unref === "function") killTimer.unref()
            }, timeoutMs)
            if (typeof timeoutId.unref === "function") timeoutId.unref()
          }

          try {
            const [stdout, stderr] = await Promise.all([
              new Response(proc.stdout as ReadableStream).text(),
              new Response(proc.stderr as ReadableStream).text(),
            ])
            const exitCode = await proc.exited
            if (timedOut) {
              return {
                stdout,
                stderr: stderr.length > 0
                  ? `${stderr}\n[shell] timed out after ${timeoutMs}ms`
                  : `[shell] timed out after ${timeoutMs}ms`,
                exitCode: -1,
              }
            }
            return { stdout, stderr, exitCode }
          } finally {
            if (timeoutId !== undefined) clearTimeout(timeoutId)
            if (killTimer !== undefined) clearTimeout(killTimer)
          }
        },
        catch: (cause) =>
          new ShellError({
            command: cmd as unknown as string,
            exitCode: -1,
            stderr: "",
            message: String(cause),
          }),
      }),
  }),
)

export const ShellTest = (
  responder: (cmd: string) => ShellResult = () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
  }),
): Layer.Layer<Shell> =>
  Layer.succeed(
    Shell,
    Shell.of({
      run: (cmd) => Effect.sync(() => responder(cmd as unknown as string)),
    }),
  )
