import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { handleWorktreeRemove } from "../../src/events/worktree-remove.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { CommandRunnerTest } from "../../src/services/command-runner.ts"
import { EventStoreLive } from "../../src/services/event-store.ts"
import { ProjectTest } from "../../src/services/project.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)
const byteLength = (value: string): number => Buffer.byteLength(value, "utf8")

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
    const root = mkTmp()
    const layer = Layer.mergeAll(
      CommandRunnerTest(),
      EventStoreLive,
      ProjectTest({ root }),
    )
    const payload = decode({
      _tag: "WorktreeRemove",
      session_id: "s1",
      hook_event_name: "WorktreeRemove",
      worktree_path: "/repo/.wt/feat-x",
    })
    const program = Effect.gen(function* () {
      const d = yield* handleWorktreeRemove(payload)
      const c = fs.readFileSync(
        path.join(root, ".claude-hooks", "state", "worktree-remove.jsonl"),
        "utf8",
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
      CommandRunnerTest(),
      EventStoreLive,
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

  test("archives ledgers through redaction and size caps", async () => {
    const mainRepo = mkTmp()
    fs.mkdirSync(path.join(mainRepo, ".git"), { recursive: true })
    const worktreeName = "feat-redact"
    const worktreePath = path.join(mainRepo, ".wt", worktreeName)
    const stateDir = path.join(worktreePath, ".claude-hooks", "state")
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(
      path.join(stateDir, "ledger.jsonl"),
      [
        JSON.stringify({
          event: "PermissionDenied",
          prompt: "TOP_SECRET_PROMPT",
          tool_input: { command: "echo TOP_SECRET_COMMAND" },
          nested: { content: "TOP_SECRET_CONTENT" },
        }),
        "not json TOP_SECRET_INVALID",
      ].join("\n") + "\n",
    )

    const layer = Layer.mergeAll(
      CommandRunnerTest(),
      EventStoreLive,
      ProjectTest({ root: mainRepo }),
    )
    const payload = decode({
      _tag: "WorktreeRemove",
      session_id: "s1",
      hook_event_name: "WorktreeRemove",
      worktree_path: worktreePath,
    })
    await Effect.runPromise(handleWorktreeRemove(payload).pipe(Effect.provide(layer)))

    const archiveRoot = path.join(
      mainRepo,
      ".claude-hooks",
      "state",
      "archived",
    )
    const match = fs.readdirSync(archiveRoot).find((s) => s.startsWith(`${worktreeName}-`))
    expect(match).toBeDefined()
    const archivedContent = fs.readFileSync(path.join(archiveRoot, match!, "ledger.jsonl"), "utf8")
    expect(archivedContent).toContain("redacted")
    expect(archivedContent).toContain("invalid_jsonl")
    expect(archivedContent).not.toContain("TOP_SECRET_PROMPT")
    expect(archivedContent).not.toContain("TOP_SECRET_COMMAND")
    expect(archivedContent).not.toContain("TOP_SECRET_CONTENT")
    expect(archivedContent).not.toContain("TOP_SECRET_INVALID")
  })

  test("keeps the first complete archive tail line at a truncation boundary", async () => {
    const mainRepo = mkTmp()
    fs.mkdirSync(path.join(mainRepo, ".git"), { recursive: true })
    const worktreeName = "feat-boundary"
    const worktreePath = path.join(mainRepo, ".wt", worktreeName)
    const stateDir = path.join(worktreePath, ".claude-hooks", "state")
    fs.mkdirSync(stateDir, { recursive: true })

    const maxArchiveBytes = 1024 * 1024
    const first = `${JSON.stringify({ event: "first", prompt: "TOP_SECRET_BOUNDARY" })}\n`
    const last = `${JSON.stringify({ event: "last" })}\n`
    const emptyFiller = `${JSON.stringify({ pad: "" })}\n`
    const fillerPadBytes =
      maxArchiveBytes - byteLength(first) - byteLength(last) - byteLength(emptyFiller)
    expect(fillerPadBytes).toBeGreaterThan(0)
    const filler = `${JSON.stringify({ pad: "x".repeat(fillerPadBytes) })}\n`
    const tail = first + filler + last
    expect(byteLength(tail)).toBe(maxArchiveBytes)

    fs.writeFileSync(path.join(stateDir, "ledger.jsonl"), `outside-tail\n${tail}`)

    const layer = Layer.mergeAll(
      CommandRunnerTest(),
      EventStoreLive,
      ProjectTest({ root: mainRepo }),
    )
    const payload = decode({
      _tag: "WorktreeRemove",
      session_id: "s1",
      hook_event_name: "WorktreeRemove",
      worktree_path: worktreePath,
    })
    await Effect.runPromise(handleWorktreeRemove(payload).pipe(Effect.provide(layer)))

    const archiveRoot = path.join(mainRepo, ".claude-hooks", "state", "archived")
    const match = fs.readdirSync(archiveRoot).find((s) => s.startsWith(`${worktreeName}-`))
    expect(match).toBeDefined()
    const archivedContent = fs.readFileSync(path.join(archiveRoot, match!, "ledger.jsonl"), "utf8")
    expect(archivedContent).toContain('"event":"first"')
    expect(archivedContent).toContain('"event":"last"')
    expect(archivedContent).toContain("file_tail_truncated")
    expect(archivedContent).not.toContain("TOP_SECRET_BOUNDARY")
  })
})
