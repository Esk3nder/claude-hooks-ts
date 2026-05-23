import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CommandRunnerTest } from "../../src/services/command-runner.ts"
import {
  sessionStatePath,
  stateRootForHook,
} from "../../src/services/state-paths.ts"

describe("state-paths", () => {
  test("stateRootForHook canonicalizes cwd through git session root", async () => {
    const root = "/repo"
    const cwd = "/repo/subdir"
    const result = await Effect.runPromise(
      stateRootForHook(cwd, {}).pipe(
        Effect.provide(
          CommandRunnerTest((_command, _args, opts) => ({
            stdout: `${root}\n`,
            stderr: "",
            exitCode: 0,
            timedOut: false,
            durationMs: 1,
            commandPreview: `git rev-parse --show-toplevel cwd=${opts?.cwd ?? ""}`,
          })),
        ),
      ),
    )

    expect(result).toBe(root)
  })

  test("stateRootForHook honors explicit state root override", async () => {
    const result = await Effect.runPromise(
      stateRootForHook("/repo/subdir", {
        CLAUDE_HOOKS_STATE_ROOT: "/override/root",
      }).pipe(
        Effect.provide(
          CommandRunnerTest(() => {
            throw new Error("override should skip git root detection")
          }),
        ),
      ),
    )

    expect(result).toBe("/override/root")
  })

  test("sessionStatePath keys the state file by frozen session_root", () => {
    expect(
      sessionStatePath({
        root: "/drift",
        sessionRoot: "/repo",
        sessionId: "sid",
      }),
    ).toBe("/repo/.claude-hooks/state/sid.json")
  })
})
