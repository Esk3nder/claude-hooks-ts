import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import * as path from "node:path"
import { handlePostCompact } from "../../src/events/postcompact-ledger.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import {
  FileSystem,
  FileSystemTest,
} from "../../src/services/filesystem.ts"
import { ProjectTest } from "../../src/services/project.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const postCompact = (sid: string, trigger?: string) =>
  decode({
    _tag: "PostCompact",
    session_id: sid,
    hook_event_name: "PostCompact",
    ...(trigger !== undefined ? { trigger } : {}),
  })

describe("handlePostCompact", () => {
  test("appends ledger entry, returns SAFE_DEFAULT", async () => {
    const fsLayer = FileSystemTest()
    const layer = Layer.mergeAll(fsLayer, ProjectTest({ root: "/proj" }))
    const program = Effect.gen(function* () {
      const decision = yield* handlePostCompact(postCompact("sid-1", "auto"))
      const fs = yield* FileSystem
      const ledger = path.join(
        "/proj",
        ".claude-hooks",
        "state",
        "postcompact-ledger.jsonl",
      )
      const content = yield* fs.readFile(ledger)
      return { decision, content }
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.decision).toEqual({})
    expect(r.content).toContain('"session_id":"sid-1"')
    expect(r.content).toContain('"trigger":"auto"')
    expect(r.content).toContain('"snapshot_path"')
    expect(r.content.endsWith("\n")).toBe(true)
  })

  test("ledger write failure → still returns SAFE_DEFAULT", async () => {
    const failingFs = Layer.succeed(FileSystem, {
      readFile: () =>
        Effect.fail({
          _tag: "FsError" as const,
          op: "readFile",
          path: "x",
          message: "boom",
        }) as never,
      writeFile: () =>
        Effect.fail({
          _tag: "FsError" as const,
          op: "writeFile",
          path: "x",
          message: "boom",
        }) as never,
      exists: () =>
        Effect.fail({
          _tag: "FsError" as const,
          op: "exists",
          path: "x",
          message: "boom",
        }) as never,
      stat: () =>
        Effect.fail({
          _tag: "FsError" as const,
          op: "stat",
          path: "x",
          message: "boom",
        }) as never,
    } as unknown as FileSystem["Type"])
    const layer = Layer.mergeAll(failingFs, ProjectTest({ root: "/proj" }))
    const d = await Effect.runPromise(
      handlePostCompact(postCompact("sid-fail")).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
  })

  test("non-PostCompact payload → SAFE_DEFAULT", async () => {
    const layer = Layer.mergeAll(FileSystemTest(), ProjectTest({ root: "/proj" }))
    const payload = decode({
      _tag: "Stop",
      session_id: "s",
      hook_event_name: "Stop",
    })
    const d = await Effect.runPromise(
      handlePostCompact(payload).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
  })
})
