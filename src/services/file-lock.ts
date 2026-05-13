import * as fs from "node:fs";
import * as path from "node:path";
import { currentProcessEnv } from "../bootstrap/env.ts";
import { durationMillis, runtimeConfigFromEnv } from "./runtime-config.ts";

const STALE_LOCK_MS = 30_000;
const RETRY_INITIAL_MS = 50;
const RETRY_MAX_MS = 1000;
const defaultRetryTimeoutMs = (): number =>
  durationMillis(runtimeConfigFromEnv(currentProcessEnv()).lockRetryTimeoutMs);

export interface LockOptions {
  readonly staleMs?: number;
  readonly timeoutMs?: number;
}

/**
 * Acquire an exclusive advisory file lock for `targetPath` (a `<targetPath>.lock`
 * sentinel file is created via O_CREAT|O_EXCL), run `fn`, and always release
 * the lock. On contention, retries with exponential backoff up to `timeoutMs`.
 *
 * Stale-lock recovery: a lock whose mtime is older than `staleMs` is treated as
 * abandoned by a crashed prior holder. To avoid the classic TOCTOU race
 * (process A stats stale → B acquires + releases → A blindly unlinks B's
 * fresh lock → C now also acquires → A and C both think they own it), the
 * recovery path checks that the lock's inode + mtimeNs are still identical
 * after observation, and only then unlinks. If a concurrent process replaced
 * the lock between observation and removal, the inode/mtime check fails and
 * recovery aborts, leaving the new lock intact.
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
  const timeout = opts.timeoutMs ?? defaultRetryTimeoutMs();
  const deadline = Date.now() + timeout;

  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    // best-effort — if mkdir fails, openSync will fail and surface the error
  }

  let backoff = RETRY_INITIAL_MS;

  while (true) {
    try {
      let fd: number | null = null;
      let acquisitionError: unknown = null;
      try {
        fd = fs.openSync(
          lockPath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        );
        fs.writeSync(fd, String(process.pid));
      } catch (err) {
        acquisitionError = err;
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch (err) {
            acquisitionError ??= err;
          }
        }
      }
      if (acquisitionError !== null) {
        // If open succeeded but write/close failed, release the sentinel
        // before surfacing the real acquisition failure. Close failures on
        // the lockfile are not safe to ignore: a caller must not enter the
        // protected section unless the sentinel was fully written and closed.
        if (fd !== null) {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // best-effort cleanup
          }
        }
        throw acquisitionError;
      }
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;

      // Stale-lock recovery with inode/mtime double-check (closes TOCTOU).
      try {
        const stat = fs.statSync(lockPath, { bigint: true });
        const ageMs = Date.now() - Number(stat.mtimeMs);
        if (ageMs > stale) {
          // Re-stat just before unlink. If inode + mtimeNs are identical to
          // what we just observed, no one has replaced the lock — safe to
          // unlink. Otherwise a fresh writer arrived; abort recovery and
          // fall through to normal backoff so we don't trample their lock.
          try {
            const stat2 = fs.statSync(lockPath, { bigint: true });
            if (stat2.ino === stat.ino && stat2.mtimeNs === stat.mtimeNs) {
              fs.unlinkSync(lockPath);
              continue;
            }
            // mtime/inode changed — someone else replaced it. Don't unlink.
          } catch {
            // file vanished between checks — retry create-exclusive immediately
            continue;
          }
        }
      } catch {
        // lock file vanished between EEXIST and stat — retry immediately
        continue;
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

  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // best-effort
    }
  }
};
