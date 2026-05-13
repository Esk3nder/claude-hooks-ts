import { Context, Effect, Layer } from "effect"
import { ShellError } from "../schema/errors.ts"
import type { ShellCommand } from "../schema/branded.ts"
import { CommandRunner } from "./command-runner.ts"

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

export const ShellLive = Layer.effect(
  Shell,
  Effect.map(CommandRunner, (runner) =>
    Shell.of({
      run: (cmd, opts) =>
        runner.runShell(cmd as unknown as string, opts).pipe(
          Effect.map(({ stdout, stderr, exitCode }) => ({ stdout, stderr, exitCode })),
          Effect.mapError((err) =>
            new ShellError({
              command: cmd as unknown as string,
              exitCode: err.exitCode,
              stderr: err.stderr,
              message: err.message,
            }),
          ),
        ),
    }),
  ),
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
