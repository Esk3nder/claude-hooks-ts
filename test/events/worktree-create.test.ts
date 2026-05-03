import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { handleWorktreeCreate } from "../../src/events/worktree-create.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { ShellTest } from "../../src/services/shell.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

describe("handleWorktreeCreate", () => {
  test("returns worktreePath on success", async () => {
    const layer = ShellTest(() => ({ stdout: "", stderr: "", exitCode: 0 }))
    const payload = decode({
      _tag: "WorktreeCreate",
      session_id: "s1",
      hook_event_name: "WorktreeCreate",
      base_path: "/repo/.wt",
      worktree_name: "feat-x",
    })
    const d = await Effect.runPromise(
      handleWorktreeCreate(payload).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({ worktreePath: "/repo/.wt/feat-x" })
  })

  test("returns SAFE_DEFAULT on git failure", async () => {
    const layer = ShellTest(() => ({
      stdout: "",
      stderr: "fatal: exists",
      exitCode: 128,
    }))
    const payload = decode({
      _tag: "WorktreeCreate",
      session_id: "s1",
      hook_event_name: "WorktreeCreate",
      base_path: "/repo/.wt",
      worktree_name: "feat-x",
    })
    const d = await Effect.runPromise(
      handleWorktreeCreate(payload).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
  })
})
