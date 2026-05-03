import { Context, Effect, Layer } from "effect"
import * as fs from "node:fs/promises"
import { FsError } from "../schema/errors.ts"

export interface FileSystemApi {
  readonly readFile: (path: string) => Effect.Effect<string, FsError>
  readonly writeFile: (
    path: string,
    contents: string,
  ) => Effect.Effect<void, FsError>
  readonly exists: (path: string) => Effect.Effect<boolean, FsError>
  readonly stat: (
    path: string,
  ) => Effect.Effect<{ isFile: boolean; isDirectory: boolean; size: number }, FsError>
}

export class FileSystem extends Context.Tag("FileSystem")<
  FileSystem,
  FileSystemApi
>() {}

export const FileSystemLive = Layer.succeed(
  FileSystem,
  FileSystem.of({
    readFile: (path) =>
      Effect.tryPromise({
        try: () => fs.readFile(path, "utf8"),
        catch: (cause) =>
          new FsError({ op: "readFile", path, message: String(cause), cause }),
      }),
    writeFile: (path, contents) =>
      Effect.tryPromise({
        try: () => fs.writeFile(path, contents, "utf8"),
        catch: (cause) =>
          new FsError({ op: "writeFile", path, message: String(cause), cause }),
      }),
    exists: (path) =>
      Effect.tryPromise({
        try: () => fs.access(path).then(() => true).catch(() => false),
        catch: (cause) =>
          new FsError({ op: "exists", path, message: String(cause), cause }),
      }),
    stat: (path) =>
      Effect.tryPromise({
        try: async () => {
          const s = await fs.stat(path)
          return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size }
        },
        catch: (cause) =>
          new FsError({ op: "stat", path, message: String(cause), cause }),
      }),
  }),
)

// In-memory test layer
export const FileSystemTest = (
  initial: ReadonlyMap<string, string> = new Map(),
): Layer.Layer<FileSystem> => {
  const store = new Map(initial)
  return Layer.succeed(
    FileSystem,
    FileSystem.of({
      readFile: (path) =>
        store.has(path)
          ? Effect.succeed(store.get(path)!)
          : Effect.fail(
              new FsError({ op: "readFile", path, message: "ENOENT" }),
            ),
      writeFile: (path, contents) =>
        Effect.sync(() => {
          store.set(path, contents)
        }),
      exists: (path) => Effect.succeed(store.has(path)),
      stat: (path) =>
        store.has(path)
          ? Effect.succeed({
              isFile: true,
              isDirectory: false,
              size: store.get(path)!.length,
            })
          : Effect.fail(new FsError({ op: "stat", path, message: "ENOENT" })),
    }),
  )
}
