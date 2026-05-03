import * as fs from "node:fs";
import * as path from "node:path";

const STALE_LOCK_MS = 30_000;
const RETRY_INITIAL_MS = 50;
const RETRY_MAX_MS = 1000;
const RETRY_TIMEOUT_MS = 5_000;

export interface LockOptions {
  readonly staleMs?: number;
  readonly timeoutMs?: number;
}

/**
 * Acquire an exclusive advisory file lock for `targetPath` (a `<targetPath>.lock`
 * sentinel file is created via O_CREAT|O_EXCL), run `fn`, and always release
 * the lock. On contention, retries with exponential backoff up to `timeoutMs`.
 * Stale locks (mtime older than `staleMs`) are force-removed and retried.
 *
 * Ensures the lockfile's parent directory exists (mkdir -p) before attempting
 * acquisition so callers don't have to.
 */
export const withFileLock = async <T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> => {
  const lockPath = `${targetPath}.lock`;
  const stale = opts.staleMs ?? STALE_LOCK_MS;
  const timeout = opts.timeoutMs ?? RETRY_TIMEOUT_MS;
  const deadline = Date.now() + timeout;

  // Ensure parent dir exists so O_CREAT can succeed.
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    // best-effort — if mkdir fails, openSync will fail and surface the error
  }

  let backoff = RETRY_INITIAL_MS;
  while (true) {
    try {
      const fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      );
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      try {
        return await fn();
      } finally {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // best-effort
        }
      }
    } catch {
      // Stale lock detection: force-remove if older than `stale` and retry now.
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > stale) {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // best-effort
          }
          continue;
        }
      } catch {
        // lock file vanished between EEXIST and stat — try again immediately
      }

      if (Date.now() > deadline) {
        throw new Error(
          `withFileLock: timeout after ${timeout}ms waiting for ${lockPath}`,
        );
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, RETRY_MAX_MS);
    }
  }
};
