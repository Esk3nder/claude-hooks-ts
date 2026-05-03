import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { handleInstructionsLoaded } from "../../src/events/instructions-loaded.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { FileSystem, FileSystemTest } from "../../src/services/filesystem.ts"
import { ProjectTest } from "../../src/services/project.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

describe("handleInstructionsLoaded", () => {
  test("captures file_path / memory_type / load_reason", async () => {
    const layer = Layer.mergeAll(FileSystemTest(), ProjectTest({ root: "/proj" }))
    const payload = decode({
      _tag: "InstructionsLoaded",
      session_id: "s1",
      hook_event_name: "InstructionsLoaded",
      file_path: "/repo/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session-start",
    })
    const program = Effect.gen(function* () {
      const d = yield* handleInstructionsLoaded(payload)
      const fs = yield* FileSystem
      const c = yield* fs.readFile(
        "/proj/.claude-hooks/state/instructions-loaded.jsonl",
      )
      return { d, c }
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.d).toEqual({})
    const e = JSON.parse(r.c.trim())
    expect(e.file_path).toBe("/repo/CLAUDE.md")
    expect(e.memory_type).toBe("Project")
    expect(e.load_reason).toBe("session-start")
  })
})
