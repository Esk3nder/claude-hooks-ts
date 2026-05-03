import { Context, Effect, Layer } from "effect"
import { GitError } from "../schema/errors.ts"

export interface GitApi {
  readonly currentBranch: (cwd?: string) => Effect.Effect<string, GitError>
  readonly isDirty: (cwd?: string) => Effect.Effect<boolean, GitError>
  readonly headSha: (cwd?: string) => Effect.Effect<string, GitError>
}

export class Git extends Context.Tag("Git")<Git, GitApi>() {}

const runGit = (args: string[], cwd?: string) =>
  Effect.tryPromise({
    try: async () => {
      const opts: Parameters<typeof Bun.spawn>[1] = {
        stdout: "pipe",
        stderr: "pipe",
      }
      if (cwd !== undefined) opts.cwd = cwd
      const proc = Bun.spawn(["git", ...args], opts)
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
      ])
      const exit = await proc.exited
      if (exit !== 0)
        throw new Error(
          stderr.trim() || `git ${args.join(" ")} exited ${exit}`,
        )
      return stdout.trim()
    },
    catch: (cause) =>
      new GitError({ op: args.join(" "), message: String(cause), cause }),
  })

export const GitLive = Layer.succeed(
  Git,
  Git.of({
    currentBranch: (cwd) => runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    isDirty: (cwd) =>
      runGit(["status", "--porcelain"], cwd).pipe(
        Effect.map((out) => out.length > 0),
      ),
    headSha: (cwd) => runGit(["rev-parse", "HEAD"], cwd),
  }),
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
