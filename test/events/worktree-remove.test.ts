import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { handleWorktreeRemove } from "../../src/events/worktree-remove.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { FileSystem, FileSystemTest } from "../../src/services/filesystem.ts"
import { ProjectTest } from "../../src/services/project.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const tmpDirs: string[] = []
const mkTmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wt-remove-"))
  tmpDirs.push(d)
  return d
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

describe("handleWorktreeRemove", () => {
  test("ledger entry + SAFE_DEFAULT", async () => {
    const layer = Layer.mergeAll(
      FileSystemTest(),
      ProjectTest({ root: "/proj" }),
    )
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

  test("archives worktree state/*.jsonl into main repo before removal", async () => {
    // Real on-disk layout: <mainRepo>/.git (dir) + <mainRepo>/.wt/<worktree>
    const mainRepo = mkTmp()
    fs.mkdirSync(path.join(mainRepo, ".git"), { recursive: true })
    const worktreeName = "feat-archive"
    const worktreePath = path.join(mainRepo, ".wt", worktreeName)
    fs.mkdirSync(path.join(worktreePath, ".claude-hooks", "state"), {
      recursive: true,
    })
    const ledgerLines =
      [
        JSON.stringify({ event: "a", n: 1 }),
        JSON.stringify({ event: "b", n: 2 }),
        JSON.stringify({ event: "c", n: 3 }),
      ].join("\n") + "\n"
    fs.writeFileSync(
      path.join(worktreePath, ".claude-hooks", "state", "ledger.jsonl"),
      ledgerLines,
    )

    const layer = Layer.mergeAll(
      FileSystemTest(),
      ProjectTest({ root: mainRepo }),
    )
    const payload = decode({
      _tag: "WorktreeRemove",
      session_id: "s1",
      hook_event_name: "WorktreeRemove",
      worktree_path: worktreePath,
    })
    const d = await Effect.runPromise(
      handleWorktreeRemove(payload).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})

    const archiveRoot = path.join(
      mainRepo,
      ".claude-hooks",
      "state",
      "archived",
    )
    const subs = fs.readdirSync(archiveRoot)
    const match = subs.find((s) => s.startsWith(`${worktreeName}-`))
    expect(match).toBeDefined()
    const archivedFile = path.join(archiveRoot, match!, "ledger.jsonl")
    expect(fs.existsSync(archivedFile)).toBe(true)
    const archivedContent = fs.readFileSync(archivedFile, "utf8")
    expect(archivedContent).toBe(ledgerLines)
    expect(archivedContent.trim().split("\n")).toHaveLength(3)
  })
})
