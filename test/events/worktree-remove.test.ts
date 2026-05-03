import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { handleWorktreeRemove } from "../../src/events/worktree-remove.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { FileSystem, FileSystemTest } from "../../src/services/filesystem.ts"
import { ProjectTest } from "../../src/services/project.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

describe("handleWorktreeRemove", () => {
  test("ledger entry + SAFE_DEFAULT", async () => {
    const layer = Layer.mergeAll(FileSystemTest(), ProjectTest({ root: "/proj" }))
    const payload = decode({
      _tag: "WorktreeRemove",
      session_id: "s1",
      hook_event_name: "WorktreeRemove",
      worktree_path: "/repo/.wt/feat-x",
    })
    const program = Effect.gen(function* () {
      const d = yield* handleWorktreeRemove(payload)
      const fs = yield* FileSystem
      const c = yield* fs.readFile(
        "/proj/.claude-hooks/state/worktree-remove.jsonl",
      )
      return { d, c }
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.d).toEqual({})
    expect(JSON.parse(r.c.trim()).worktree_path).toBe("/repo/.wt/feat-x")
  })
})
