/** Filesystem primitives: confinement, O_NOFOLLOW reads, atomic writes, mkdir locks (BUILD-SPEC §2). */
import {
  mkdirSync,
  renameSync,
  writeFileSync,
  rmdirSync,
  statSync,
  appendFileSync,
  openSync,
  readSync,
  closeSync,
  constants as C,
} from "node:fs"
import { join, dirname, resolve, sep } from "node:path"

export function stateRoot(project: string): string {
  return join(project, ".claude-hooks")
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
/** run_id segments are id-charset, joined by "/" (BUILD-SPEC §2, §6.2). */
export function isValidId(id: string): boolean {
  return ID_RE.test(id)
}
export function isValidRunId(runId: string): boolean {
  return runId.length > 0 && runId.split("/").every(isValidId)
}

/** Resolve `rel` under `root`; reject escapes. Returns absolute path or null. */
export function confine(root: string, rel: string): string | null {
  if (rel.includes("\0")) return null
  const abs = resolve(root, rel)
  const realRoot = resolve(root)
  if (abs !== realRoot && !abs.startsWith(realRoot + sep)) return null
  return abs
}

/** Open a hook-only file refusing symlinks (O_NOFOLLOW) and group/other-writable files. */
export function readHookOnly(path: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(path, C.O_RDONLY | C.O_NOFOLLOW)
    const st = statSync(path)
    if (!st.isFile()) return null
    if ((st.mode & 0o022) !== 0) return null // group/other writable ⇒ tamper signal
    const buf = Buffer.alloc(st.size)
    readSync(fd, buf, 0, st.size, 0)
    return buf.toString("utf8")
  } catch {
    return null
  } finally {
    if (fd !== null) try { closeSync(fd) } catch { /* ignore */ }
  }
}

export function writeHookOnly(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${process.hrtime.bigint()}`
  writeFileSync(tmp, content, { mode: 0o600 })
  renameSync(tmp, path)
}

export function hookLog(project: string, line: string): void {
  try {
    const p = join(stateRoot(project), "eventstore", "hook.log")
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, `${new Date().toISOString()} ${line}\n`)
  } catch { /* never throws */ }
}

const LOCK_STALE_MS = 10_000, LOCK_RETRY_MS = 20, LOCK_MAX_WAIT_MS = 3_000
export async function withLock<T>(path: string, body: () => T | Promise<T>): Promise<T> {
  const lockDir = `${path}.lock`
  mkdirSync(dirname(lockDir), { recursive: true })
  const deadline = Date.now() + LOCK_MAX_WAIT_MS
  for (;;) {
    try {
      mkdirSync(lockDir)
      try {
        return await body()
      } finally {
        try { rmdirSync(lockDir) } catch { /* released */ }
      }
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) { rmdirSync(lockDir); continue }
      } catch { continue }
      if (Date.now() > deadline) throw new Error(`lock timeout: ${lockDir}`)
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS))
    }
  }
}
