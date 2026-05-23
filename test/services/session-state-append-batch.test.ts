import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  SessionState,
  SessionStateLive,
  type AppendableKey,
} from "../../src/services/session-state.ts"

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "session-state-batch-"))
})

afterEach(async () => {
  try {
    await fs.rm(root, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

describe("SessionState.appendBatch — coalesced I/O (M9 fix #5)", () => {
  test("5 entries → exactly 1 write to the session file", async () => {
    const sessionId = "sid-batch-1"
    const file = path.join(root, ".claude-hooks", "state", `${sessionId}.json`)

    const readSpy = spyOn(fs, "readFile")
    const writeSpy = spyOn(fs, "writeFile")
    const renameSpy = spyOn(fs, "rename")

    try {
      const entries: ReadonlyArray<{
        readonly key: AppendableKey
        readonly value: string
      }> = [
        { key: "files_read", value: "/a.ts" },
        { key: "files_read", value: "/b.ts" },
        { key: "files_changed", value: "/c.ts" },
        { key: "commands_run", value: "bun test" },
        { key: "tests_run", value: "bun test" },
      ]
      await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* SessionState
          yield* api.appendBatch(sessionId, entries)
        }).pipe(Effect.provide(SessionStateLive(root))),
      )

      const writesToFile = writeSpy.mock.calls.filter((c) => c[0] === file)
      const tempWritesForFile = writeSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].startsWith(`${file}.tmp-`),
      )
      const renamesToFile = renameSpy.mock.calls.filter((c) => c[1] === file)
      const readsToFile = readSpy.mock.calls.filter((c) => c[0] === file)

      // Atomic commit writes a same-directory temp file and renames it over
      // the target; the final JSON path must never be written in place.
      expect(writesToFile.length).toBe(0)
      expect(tempWritesForFile.length).toBe(1)
      expect(renamesToFile.length).toBe(1)
      expect(readsToFile.length).toBeLessThanOrEqual(1)

      // Verify all entries persisted in single coalesced write.
      expect(fsSync.existsSync(file)).toBe(true)
      const raw = fsSync.readFileSync(file, "utf8")
      const obj = JSON.parse(raw) as Record<string, unknown>
      expect(obj["files_read"]).toEqual(["/a.ts", "/b.ts"])
      expect(obj["files_changed"]).toEqual(["/c.ts"])
      expect(obj["commands_run"]).toEqual(["bun test"])
      expect(obj["tests_run"]).toEqual(["bun test"])
    } finally {
      readSpy.mockRestore()
      writeSpy.mockRestore()
      renameSpy.mockRestore()
    }
  })

  test("appendBatch on pre-existing session file: exactly 1 read + 1 atomic commit", async () => {
    const sessionId = "sid-batch-2"
    const file = path.join(root, ".claude-hooks", "state", `${sessionId}.json`)

    // Pre-seed.
    await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* SessionState
        yield* api.append(sessionId, "files_read", "/seed.ts")
      }).pipe(Effect.provide(SessionStateLive(root))),
    )
    expect(fsSync.existsSync(file)).toBe(true)

    const readSpy = spyOn(fs, "readFile")
    const writeSpy = spyOn(fs, "writeFile")
    const renameSpy = spyOn(fs, "rename")
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* SessionState
          yield* api.appendBatch(sessionId, [
            { key: "files_read", value: "/x.ts" },
            { key: "files_read", value: "/y.ts" },
            { key: "files_read", value: "/z.ts" },
          ])
        }).pipe(Effect.provide(SessionStateLive(root))),
      )
      const writesToFile = writeSpy.mock.calls.filter((c) => c[0] === file)
      const tempWritesForFile = writeSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].startsWith(`${file}.tmp-`),
      )
      const renamesToFile = renameSpy.mock.calls.filter((c) => c[1] === file)
      const readsToFile = readSpy.mock.calls.filter((c) => c[0] === file)
      expect(readsToFile.length).toBe(1)
      expect(writesToFile.length).toBe(0)
      expect(tempWritesForFile.length).toBe(1)
      expect(renamesToFile.length).toBe(1)
    } finally {
      readSpy.mockRestore()
      writeSpy.mockRestore()
      renameSpy.mockRestore()
    }
  })

  test("update and reset commit through temp-file rename, never in-place writes", async () => {
    const sessionId = "sid-atomic-update"
    const file = path.join(root, ".claude-hooks", "state", `${sessionId}.json`)

    const writeSpy = spyOn(fs, "writeFile")
    const renameSpy = spyOn(fs, "rename")
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* SessionState
          yield* api.update(sessionId, { verification_status: "passed" })
          yield* api.reset(sessionId)
        }).pipe(Effect.provide(SessionStateLive(root))),
      )

      const writesToFile = writeSpy.mock.calls.filter((c) => c[0] === file)
      const tempWritesForFile = writeSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].startsWith(`${file}.tmp-`),
      )
      const renamesToFile = renameSpy.mock.calls.filter((c) => c[1] === file)

      expect(writesToFile.length).toBe(0)
      expect(tempWritesForFile.length).toBe(2)
      expect(renamesToFile.length).toBe(2)
    } finally {
      writeSpy.mockRestore()
      renameSpy.mockRestore()
    }
  })

  test("append() is a thin wrapper — single entry still works", async () => {
    const sessionId = "sid-batch-3"
    await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* SessionState
        yield* api.append(sessionId, "commands_run", "ls")
        const got = yield* api.get(sessionId)
        expect(got.commands_run).toEqual(["ls"])
      }).pipe(Effect.provide(SessionStateLive(root))),
    )
  })
})
