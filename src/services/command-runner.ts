import * as Command from "@effect/platform/Command"
import * as CommandExecutor from "@effect/platform/CommandExecutor"
import type { Process } from "@effect/platform/CommandExecutor"
import * as BunCommandExecutor from "@effect/platform-bun/BunCommandExecutor"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { Cause, Context, Effect, Layer, Stream } from "effect"
import { ShellError } from "../schema/errors.ts"
import { currentProcessEnv } from "../bootstrap/env.ts"

export interface CommandRunOptions {
  readonly cwd?: string
  readonly env?: Record<string, string | undefined>
  readonly stdin?: string
  readonly timeoutMs?: number
  readonly stdoutMaxBytes?: number
  readonly stderrMaxBytes?: number
  readonly scrubEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
}

export interface CommandRunResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly timedOut: boolean
  readonly durationMs: number
  readonly commandPreview: string
}

export interface CommandRunnerApi {
  readonly run: (
    command: string,
    args?: ReadonlyArray<string>,
    opts?: CommandRunOptions,
  ) => Effect.Effect<CommandRunResult, ShellError>
  readonly runShell: (
    command: string,
    opts?: CommandRunOptions,
  ) => Effect.Effect<CommandRunResult, ShellError>
}

export class CommandRunner extends Context.Tag("CommandRunner")<
  CommandRunner,
  CommandRunnerApi
>() {}

export const DEFAULT_COMMAND_STDOUT_MAX_BYTES = 10_000_000
export const DEFAULT_COMMAND_STDERR_MAX_BYTES = 10_000_000

const timeoutMessage = (timeoutMs: number): string =>
  `[command-runner] timed out after ${timeoutMs}ms`

const previewOf = (command: string, args: ReadonlyArray<string>): string =>
  [command, ...args].join(" ")

const mergeEnv = (opts?: CommandRunOptions): Record<string, string | undefined> => {
  const merged = { ...currentProcessEnv(), ...(opts?.env ?? {}) }
  return opts?.scrubEnv?.(merged) ?? merged
}

const collectTextCapped = (
  stream: Stream.Stream<Uint8Array, unknown, unknown>,
  cap: number,
): Effect.Effect<string, unknown, unknown> =>
  Stream.runFold(
    stream,
    { text: "", bytes: 0, truncated: false },
    (acc, chunk) => {
      if (acc.bytes >= cap) return { ...acc, truncated: true }
      const remaining = cap - acc.bytes
      const next = chunk.length > remaining ? chunk.slice(0, remaining) : chunk
      return {
        text: acc.text + new TextDecoder().decode(next),
        bytes: acc.bytes + next.length,
        truncated: acc.truncated || chunk.length > remaining,
      }
    },
  ).pipe(
    Effect.map((acc) =>
      acc.truncated ? `${acc.text}\n[command-runner] output truncated at ${cap} bytes` : acc.text,
    ),
  )

const releaseProcess = (process: Process): Effect.Effect<void> =>
  process.isRunning.pipe(
    Effect.catchAll(() => Effect.succeed(false)),
    Effect.flatMap((running) =>
      running
        ? process.kill("SIGTERM").pipe(
            Effect.catchAll(() => Effect.void),
            Effect.zipRight(Effect.sleep("100 millis")),
            Effect.zipRight(
              process.isRunning.pipe(
                Effect.catchAll(() => Effect.succeed(false)),
                Effect.flatMap((stillRunning) =>
                  stillRunning ? process.kill("SIGKILL") : Effect.void,
                ),
                Effect.catchAll(() => Effect.void),
              ),
            ),
          )
        : Effect.void,
    ),
  )

const runCommandEffect = (
  commandName: string,
  args: ReadonlyArray<string>,
  opts?: CommandRunOptions,
): Effect.Effect<CommandRunResult, ShellError, unknown> => {
  const startedAt = Date.now()
  const commandPreview = previewOf(commandName, args)
  let cmd = Command.make(commandName, ...args)
  cmd = Command.env(cmd, mergeEnv(opts))
  cmd = Command.stdout(cmd, "pipe")
  cmd = Command.stderr(cmd, "pipe")
  if (opts?.stdin !== undefined) cmd = Command.feed(cmd, opts.stdin)
  if (opts?.cwd !== undefined) cmd = Command.workingDirectory(cmd, opts.cwd)

  const stdoutMaxBytes = opts?.stdoutMaxBytes ?? DEFAULT_COMMAND_STDOUT_MAX_BYTES
  const stderrMaxBytes = opts?.stderrMaxBytes ?? DEFAULT_COMMAND_STDERR_MAX_BYTES

  const scoped = Effect.scoped(
    Effect.acquireRelease(Command.start(cmd), releaseProcess).pipe(
      Effect.flatMap((process) =>
        Effect.all(
          {
            stdout: collectTextCapped(process.stdout, stdoutMaxBytes),
            stderr: collectTextCapped(process.stderr, stderrMaxBytes),
            exitCode: process.exitCode,
          },
          { concurrency: "unbounded" },
        ),
      ),
    ),
  )

  const bounded =
    typeof opts?.timeoutMs === "number" && opts.timeoutMs > 0
      ? scoped.pipe(
          Effect.timeoutFail({
            duration: `${opts.timeoutMs} millis`,
            onTimeout: () => "timeout" as const,
          }),
        )
      : scoped

  return bounded.pipe(
    Effect.map(({ stdout, stderr, exitCode }) => ({
      stdout,
      stderr,
      exitCode: Number(exitCode),
      timedOut: false,
      durationMs: Date.now() - startedAt,
      commandPreview,
    })),
    Effect.catchAll((cause) => {
      if (cause === "timeout") {
        const timeoutMs = opts?.timeoutMs ?? 0
        return Effect.succeed({
          stdout: "",
          stderr: timeoutMessage(timeoutMs),
          exitCode: -1,
          timedOut: true,
          durationMs: Date.now() - startedAt,
          commandPreview,
        })
      }
      return Effect.fail(
        new ShellError({
          command: commandPreview,
          exitCode: -1,
          stderr: "",
          message: Cause.pretty(Cause.fail(cause)),
        }),
      )
    }),
    Effect.catchAllCause((cause) =>
      Effect.fail(
        new ShellError({
          command: commandPreview,
          exitCode: -1,
          stderr: "",
          message: Cause.pretty(cause),
        }),
      ),
    ),
  )
}

export const CommandRunnerLive = Layer.effect(
  CommandRunner,
  Effect.map(CommandExecutor.CommandExecutor, (executor) =>
    CommandRunner.of({
      run: (command, args = [], opts) =>
        runCommandEffect(command, args, opts).pipe(
          Effect.provideService(CommandExecutor.CommandExecutor, executor),
        ) as Effect.Effect<CommandRunResult, ShellError>,
      runShell: (command, opts) =>
        runCommandEffect("sh", ["-c", command], opts).pipe(
          Effect.provideService(CommandExecutor.CommandExecutor, executor),
        ) as Effect.Effect<CommandRunResult, ShellError>,
    }),
  ),
)

export const CommandRunnerPlatformLive = Layer.provide(
  CommandRunnerLive,
  BunCommandExecutor.layer.pipe(Layer.provide(BunFileSystem.layer)),
)

export const runCommandLive = (
  command: string,
  args: ReadonlyArray<string> = [],
  opts?: CommandRunOptions,
): Promise<CommandRunResult> =>
  Effect.runPromise(
    (runCommandEffect(command, args, opts).pipe(
      Effect.provide(BunCommandExecutor.layer.pipe(Layer.provide(BunFileSystem.layer))),
    ) as Effect.Effect<CommandRunResult, ShellError>),
  )

export const runShellCommandLive = (
  command: string,
  opts?: CommandRunOptions,
): Promise<CommandRunResult> => runCommandLive("sh", ["-c", command], opts)

export const CommandRunnerTest = (
  responder: (
    command: string,
    args: ReadonlyArray<string>,
    opts?: CommandRunOptions,
  ) => CommandRunResult = (command, args) => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    durationMs: 0,
    commandPreview: previewOf(command, args),
  }),
): Layer.Layer<CommandRunner> =>
  Layer.succeed(
    CommandRunner,
    CommandRunner.of({
      run: (command, args = [], opts) => Effect.sync(() => responder(command, args, opts)),
      runShell: (command, opts) => Effect.sync(() => responder("sh", ["-c", command], opts)),
    }),
  )
