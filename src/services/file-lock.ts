import * as PlatformFileSystem from "@effect/platform/FileSystem"
import * as PlatformPath from "@effect/platform/Path"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { Context, Data, Effect, Layer, Option, Schedule } from "effect"
import * as fsSync from "node:fs"
import { currentProcessEnv } from "../bootstrap/env.ts"
import { durationMillis, runtimeConfigFromEnv } from "./runtime-config.ts"

const STALE_LOCK_MS = 30_000
const RETRY_INITIAL_MS = 5

const defaultRetryTimeoutMs = (): number =>
  durationMillis(runtimeConfigFromEnv(currentProcessEnv()).lockRetryTimeoutMs)

export interface LockOptions {
  readonly staleMs?: number
  readonly timeoutMs?: number
}

class LockContention extends Data.TaggedError("LockContention")<{
  readonly lockPath: string
}> {}

export class LockFailure extends Data.TaggedError("LockFailure")<{
  readonly lockPath: string
  readonly message: string
  readonly cause?: unknown
}> {}

export interface FileLockApi {
  readonly withLock: <A, E, R>(
    targetPath: string,
    body: Effect.Effect<A, E, R>,
    opts?: LockOptions,
  ) => Effect.Effect<A, E | LockFailure, R>
}

export class FileLock extends Context.Tag("FileLock")<FileLock, FileLockApi>() {}

const isAlreadyExists = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  (("code" in cause && (cause as { code?: unknown }).code === "EEXIST") ||
    ("_tag" in cause &&
      (cause as { _tag?: unknown })._tag === "SystemError" &&
      "reason" in cause &&
      (cause as { reason?: unknown }).reason === "AlreadyExists"))

const lockRetrySchedule = Schedule.union(
  Schedule.exponential(`${RETRY_INITIAL_MS} millis`),
  Schedule.spaced(`${RETRY_INITIAL_MS} millis`),
)

const parseLockPid = (raw: string): number | null => {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  try {
    const parsed = JSON.parse(trimmed) as { pid?: unknown }
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return parsed.pid
    }
  } catch {
    // Legacy lock files contained just the pid as text.
  }
  const pid = Number(trimmed)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

const pidIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    const code = typeof cause === "object" && cause !== null
      ? (cause as { code?: unknown }).code
      : undefined
    return code === "EPERM"
  }
}

const lockOwnerAlive = (
  fs: PlatformFileSystem.FileSystem,
  lockPath: string,
): Effect.Effect<boolean, never> =>
  fs.readFileString(lockPath).pipe(
    Effect.map((raw) => {
      const pid = parseLockPid(raw)
      return pid !== null && pidIsRunning(pid)
    }),
    Effect.catchAll(() => Effect.succeed(false)),
  )

const recoverStaleLock = (
  fs: PlatformFileSystem.FileSystem,
  lockPath: string,
  staleMs: number,
): Effect.Effect<void, never> =>
  fs.stat(lockPath).pipe(
    Effect.flatMap((stat) => {
      const mtime = Option.getOrUndefined(stat.mtime)
      if (mtime === undefined || Date.now() - mtime.getTime() <= staleMs) {
        return Effect.void
      }
      return lockOwnerAlive(fs, lockPath).pipe(
        Effect.flatMap((alive) => {
          if (alive) return Effect.void
          return fs.stat(lockPath).pipe(
            Effect.flatMap((latest) => {
              const latestMtime = Option.getOrUndefined(latest.mtime)
              const sameInode = Option.getOrUndefined(latest.ino) === Option.getOrUndefined(stat.ino)
              const sameMtime =
                latestMtime !== undefined && latestMtime.getTime() === mtime.getTime()
              return sameInode && sameMtime
                ? fs.remove(lockPath, { force: true })
                : Effect.void
            }),
            Effect.catchAll(() => Effect.void),
          )
        }),
      )
    }),
    Effect.catchAll(() => Effect.void),
  )

const acquireLock = (
  fs: PlatformFileSystem.FileSystem,
  path: PlatformPath.Path,
  targetPath: string,
  staleMs: number,
): Effect.Effect<string, LockContention | LockFailure> =>
  Effect.gen(function* () {
    const lockPath = `${targetPath}.lock`
    yield* fs.makeDirectory(path.dirname(lockPath), { recursive: true }).pipe(
      Effect.catchAll(() => Effect.void),
    )
    const opened = yield* Effect.try({
      try: () => {
        let fd: number | null = null
        let acquisitionError: unknown = null
        try {
          fd = fsSync.openSync(
            lockPath,
            fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_WRONLY,
          )
          fsSync.writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
        } catch (cause) {
          acquisitionError = cause
        } finally {
          if (fd !== null) {
            try {
              fsSync.closeSync(fd)
            } catch (cause) {
              acquisitionError ??= cause
            }
          }
        }
        if (acquisitionError !== null) {
          if (fd !== null) {
            try {
              fsSync.unlinkSync(lockPath)
            } catch {
              // best-effort cleanup before surfacing the acquisition failure
            }
          }
          throw acquisitionError
        }
      },
      catch: (cause) => cause,
    }).pipe(Effect.either)
    if (opened._tag === "Right") return lockPath
    const cause = opened.left
    if (isAlreadyExists(cause)) {
      yield* recoverStaleLock(fs, lockPath, staleMs)
      return yield* Effect.fail(new LockContention({ lockPath }))
    }
    return yield* Effect.fail(
      new LockFailure({
        lockPath,
        message: String(cause),
        cause,
      }),
    )
  })

export const FileLockLive = Layer.effect(
  FileLock,
  Effect.gen(function* () {
    const fs = yield* PlatformFileSystem.FileSystem
    const path = yield* PlatformPath.Path
    return FileLock.of({
      withLock: <A, E, R>(
        targetPath: string,
        body: Effect.Effect<A, E, R>,
        opts: LockOptions = {},
      ) => {
        const staleMs = opts.staleMs ?? STALE_LOCK_MS
        const timeoutMs = opts.timeoutMs ?? defaultRetryTimeoutMs()
        const lockPath = `${targetPath}.lock`
        const policy = Schedule.intersect(
          Schedule.intersect(lockRetrySchedule, Schedule.recurUpTo(`${timeoutMs} millis`)),
          Schedule.recurWhile((err: LockContention | LockFailure) => err instanceof LockContention),
        )
        const acquire = acquireLock(fs, path, targetPath, staleMs).pipe(
          Effect.retry(policy),
          Effect.mapError((cause) =>
            cause instanceof LockFailure
              ? cause
              : new LockFailure({
                  lockPath,
                  message: `withFileLock: timeout after ${timeoutMs}ms waiting for ${lockPath}`,
                  cause,
                }),
          ),
        )
        return Effect.acquireUseRelease(
          acquire,
          () => body,
          (heldLockPath) =>
            fs.remove(heldLockPath, { force: true }).pipe(Effect.catchAll(() => Effect.void)),
        )
      },
    })
  }),
)

export const FileLockPlatformLive = Layer.provide(
  FileLockLive,
  Layer.merge(BunFileSystem.layer, BunPath.layer),
)

/**
 * Promise adapter kept for legacy call sites and tests. All policy lives in
 * FileLockLive; this adapter only bridges non-Effect callers.
 */
export const withFileLock = async <T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> =>
  Effect.runPromise(
    Effect.flatMap(FileLock, (locks) =>
      locks.withLock(
        targetPath,
        Effect.tryPromise({
          try: fn,
          catch: (cause) => cause,
        }),
        opts,
      ),
    ).pipe(Effect.provide(FileLockPlatformLive)),
  )
