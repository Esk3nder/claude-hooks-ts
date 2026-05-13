import { Context, Effect, Layer } from "effect"
import { GitError } from "../schema/errors.ts"
import { CommandRunner } from "./command-runner.ts"

export interface GitApi {
  readonly currentBranch: (cwd?: string) => Effect.Effect<string, GitError>
  readonly isDirty: (cwd?: string) => Effect.Effect<boolean, GitError>
  readonly headSha: (cwd?: string) => Effect.Effect<string, GitError>
}

export class Git extends Context.Tag("Git")<Git, GitApi>() {}

const runGit = (runner: CommandRunner["Type"], args: string[], cwd?: string) =>
  runner.run("git", args, cwd === undefined ? { timeoutMs: 5_000 } : { cwd, timeoutMs: 5_000 }).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode !== 0) {
        const msg = (
          result.stderr.trim() ||
          `git ${args.join(" ")} exited ${result.exitCode}`
        ).slice(0, 500)
        return Effect.fail(
          new GitError({ op: args.join(" "), message: msg, cause: result }),
        )
      }
      return Effect.succeed(result.stdout.trim())
    }),
    Effect.mapError((cause) =>
      cause instanceof GitError
        ? cause
        : new GitError({ op: args.join(" "), message: String(cause), cause }),
    ),
  )

export const GitLive = Layer.effect(
  Git,
  Effect.map(CommandRunner, (runner) =>
    Git.of({
      currentBranch: (cwd) => runGit(runner, ["rev-parse", "--abbrev-ref", "HEAD"], cwd),
      isDirty: (cwd) =>
        runGit(runner, ["status", "--porcelain"], cwd).pipe(
          Effect.map((out) => out.length > 0),
        ),
      headSha: (cwd) => runGit(runner, ["rev-parse", "HEAD"], cwd),
    }),
  ),
)

export const GitTest = (
  state: { branch?: string; dirty?: boolean; sha?: string } = {},
): Layer.Layer<Git> =>
  Layer.succeed(
    Git,
    Git.of({
      currentBranch: () => Effect.succeed(state.branch ?? "main"),
      isDirty: () => Effect.succeed(state.dirty ?? false),
      headSha: () => Effect.succeed(state.sha ?? "0".repeat(40)),
    }),
  )
