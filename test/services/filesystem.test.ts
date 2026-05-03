import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FileSystem, FileSystemTest } from "../../src/services/filesystem.ts"

describe("FileSystem (test layer)", () => {
  test("readFile returns seeded content", async () => {
    const layer = FileSystemTest(new Map([["/a.txt", "hello"]]))
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(FileSystem, (fs) => fs.readFile("/a.txt")),
        layer,
      ),
    )
    expect(result).toBe("hello")
  })

  test("writeFile then exists", async () => {
    const layer = FileSystemTest()
    const ran = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const fs = yield* FileSystem
          yield* fs.writeFile("/b.txt", "world")
          return yield* fs.exists("/b.txt")
        }),
        layer,
      ),
    )
    expect(ran).toBe(true)
  })
})
