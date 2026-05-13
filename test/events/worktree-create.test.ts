import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { handleWorktreeCreate } from "../../src/events/worktree-create.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { ShellTest } from "../../src/services/shell.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const tmpDirs: string[] = []
const mkTmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wt-create-"))
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

  test("returns NO_DECISION on git failure", async () => {
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

  test("mirrors .claude-hooks YAML and creates empty state/ in target", async () => {
    const sourceCwd = mkTmp()
    const targetParent = mkTmp()
    const worktreeName = "feat-mirror"
    const targetPath = path.join(targetParent, worktreeName)

    fs.mkdirSync(path.join(sourceCwd, ".claude-hooks", "state"), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(sourceCwd, ".claude-hooks", "foo.yaml"),
      "key: value\n",
    )
    fs.writeFileSync(
      path.join(sourceCwd, ".claude-hooks", "bar.yml"),
      "other: 1\n",
    )
    fs.writeFileSync(
      path.join(sourceCwd, ".claude-hooks", "ignored.txt"),
      "skip me\n",
    )
    fs.writeFileSync(
      path.join(sourceCwd, ".claude-hooks", "state", "ledger.jsonl"),
      "{}\n",
    )

    // Mock Shell to "succeed" but actually create the target dir so the
    // mirror step has a real place to copy into.
    const layer = ShellTest(() => {
      fs.mkdirSync(targetPath, { recursive: true })
      return { stdout: "", stderr: "", exitCode: 0 }
    })

    const payload = decode({
      _tag: "WorktreeCreate",
      session_id: "s1",
      hook_event_name: "WorktreeCreate",
      cwd: sourceCwd,
      base_path: targetParent,
      worktree_name: worktreeName,
    })
    const d = await Effect.runPromise(
      handleWorktreeCreate(payload).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({ worktreePath: targetPath })

    expect(
      fs.readFileSync(
        path.join(targetPath, ".claude-hooks", "foo.yaml"),
        "utf8",
      ),
    ).toBe("key: value\n")
    expect(
      fs.readFileSync(
        path.join(targetPath, ".claude-hooks", "bar.yml"),
        "utf8",
      ),
    ).toBe("other: 1\n")
    expect(
      fs.existsSync(path.join(targetPath, ".claude-hooks", "ignored.txt")),
    ).toBe(false)
    const stateStat = fs.statSync(
      path.join(targetPath, ".claude-hooks", "state"),
    )
    expect(stateStat.isDirectory()).toBe(true)
    expect(
      fs.readdirSync(path.join(targetPath, ".claude-hooks", "state")),
    ).toEqual([])
  })
})
