import { Context, Effect, Layer } from "effect"
import { ShellError } from "../schema/errors.ts"
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
            spawnOpts.env = { ...process.env, ...opts.env } as Record<string, string>
          const proc = Bun.spawn(
            ["sh", "-c", cmd as unknown as string],
            spawnOpts,
          )
          const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout as ReadableStream).text(),
            new Response(proc.stderr as ReadableStream).text(),
          ])
          const exitCode = await proc.exited
          return { stdout, stderr, exitCode }
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
