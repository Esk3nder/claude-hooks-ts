import { Context, Effect, Layer } from "effect";
import * as fs from "node:fs/promises";
import { FsError } from "../schema/errors.ts";
import { FileLock, FileLockPlatformLive, LockFailure } from "./file-lock.ts";

export interface FileSystemApi {
  readonly readFile: (path: string) => Effect.Effect<string, FsError>;
  readonly writeFile: (
    path: string,
    contents: string,
  ) => Effect.Effect<void, FsError>;
  readonly exists: (path: string) => Effect.Effect<boolean, FsError>;
  readonly stat: (
    path: string,
  ) => Effect.Effect<
    { isFile: boolean; isDirectory: boolean; size: number },
    FsError
  >;
  /**
   * Acquire an advisory cross-process lock on `targetPath` for the duration of
   * `body`. Use this around read-modify-write JSONL appends to prevent
   * interleaved partial lines from concurrent processes.
   *
   * The Live impl uses an O_EXCL sentinel file; the Test impl is a no-op
   * pass-through (in-memory store is single-process).
   */
  readonly withLock: <A, E>(
    targetPath: string,
    body: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | FsError>;
}

export class FileSystem extends Context.Tag("FileSystem")<
  FileSystem,
  FileSystemApi
>() {}

const FileSystemLiveBase = Layer.effect(
  FileSystem,
  Effect.map(FileLock, (locks) => FileSystem.of({
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
        try: () =>
          fs
            .access(path)
            .then(() => true)
            .catch(() => false),
        catch: (cause) =>
          new FsError({ op: "exists", path, message: String(cause), cause }),
      }),
    stat: (path) =>
      Effect.tryPromise({
        try: async () => {
          const s = await fs.stat(path);
          return {
            isFile: s.isFile(),
            isDirectory: s.isDirectory(),
            size: s.size,
          };
        },
        catch: (cause) =>
          new FsError({ op: "stat", path, message: String(cause), cause }),
      }),
    withLock: <A, E>(targetPath: string, body: Effect.Effect<A, E>) =>
      locks.withLock(targetPath, body).pipe(
        Effect.mapError((cause) =>
          cause instanceof LockFailure
            ? new FsError({
                op: "withLock",
                path: targetPath,
                message: String(cause),
                cause,
              })
            : cause,
        ),
      ),
  })),
);

export const FileSystemLive = Layer.provide(FileSystemLiveBase, FileLockPlatformLive);

// In-memory test layer
export const FileSystemTest = (
  initial: ReadonlyMap<string, string> = new Map(),
): Layer.Layer<FileSystem> => {
  const store = new Map(initial);
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
          store.set(path, contents);
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
      // In-memory test layer is single-process; no lock needed.
      withLock: (_targetPath, body) => body,
    }),
  );
};
