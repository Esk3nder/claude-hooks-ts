#!/usr/bin/env bun
// usage: bun run scripts/tail.ts [--session <id>] [--since <iso>] [--cwd <path>]
//
// Streams claude-hooks ledger entries to stdout in a `tail -f` style.
// Reads `<cwd>/.claude-hooks/state/<session>/ledger.jsonl` when --session
// is supplied. Otherwise globs `<cwd>/.claude-hooks/state/**/ledger.jsonl`
// (and falls back to `<cwd>/.claude/ledger.jsonl` if present) and follows them.
// Stops cleanly on SIGINT.

import { Effect, Stream } from "effect"
import * as fs from "node:fs"
import * as fsP from "node:fs/promises"
import * as path from "node:path"

const INITIAL_TAIL_MAX_BYTES = 1024 * 1024

interface Args {
  readonly session: string | null
  readonly since: number | null
  readonly cwd: string
}

const parseArgs = (argv: ReadonlyArray<string>): Args => {
  let session: string | null = null
  let since: number | null = null
  let cwd = process.cwd()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--session" && i + 1 < argv.length) {
      session = argv[++i] ?? null
    } else if (a === "--since" && i + 1 < argv.length) {
      const t = Date.parse(argv[++i] ?? "")
      since = Number.isNaN(t) ? null : t
    } else if (a === "--cwd" && i + 1 < argv.length) {
      cwd = path.resolve(argv[++i] ?? cwd)
    }
  }
  return { session, since, cwd }
}

const collectLedgers = async (args: Args): Promise<string[]> => {
  const stateDir = path.join(args.cwd, ".claude-hooks", "state")
  const out: string[] = []
  if (args.session !== null) {
    const p = path.join(stateDir, args.session, "ledger.jsonl")
    out.push(p)
    return out
  }
  // Walk one level: .claude-hooks/state/<id>/ledger.jsonl
  if (fs.existsSync(stateDir)) {
    const entries = await fsP.readdir(stateDir, { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory()) {
        const p = path.join(stateDir, e.name, "ledger.jsonl")
        if (fs.existsSync(p)) out.push(p)
      }
      // Also accept ledger.jsonl files at the top level of state/
      if (e.isFile() && e.name === "ledger.jsonl") {
        out.push(path.join(stateDir, e.name))
      }
    }
  }
  // Fallback to legacy location
  const legacy = path.join(args.cwd, ".claude", "ledger.jsonl")
  if (fs.existsSync(legacy)) out.push(legacy)
  return out
}

interface FileTail {
  readonly file: string
  offset: number
}

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { code?: unknown }).code === "ENOENT"

const nonEmptyLines = (raw: string): string[] =>
  raw.split(/\r?\n/).filter((line) => line.trim().length > 0)

const readInitialTail = async (file: string): Promise<{ readonly lines: string[]; readonly offset: number }> => {
  let stat: fs.Stats
  try {
    stat = await fsP.stat(file)
  } catch (cause) {
    if (isNotFound(cause)) return { lines: [], offset: 0 }
    throw cause
  }
  const offset = stat.size
  if (!stat.isFile() || stat.size <= 0) return { lines: [], offset }
  const length = Math.min(stat.size, INITIAL_TAIL_MAX_BYTES)
  const start = Math.max(0, stat.size - length)
  const handle = await fsP.open(file, "r")
  try {
    const buffer = Buffer.alloc(length)
    let bytesReadTotal = 0
    while (bytesReadTotal < length) {
      const { bytesRead } = await handle.read(
        buffer,
        bytesReadTotal,
        length - bytesReadTotal,
        start + bytesReadTotal,
      )
      if (bytesRead === 0) break
      bytesReadTotal += bytesRead
    }
    let raw = buffer.subarray(0, bytesReadTotal).toString("utf8")
    if (start > 0) {
      const previous = Buffer.alloc(1)
      const { bytesRead } = await handle.read(previous, 0, 1, start - 1)
      const startsOnLineBoundary = bytesRead === 1 && (previous[0] === 0x0a || previous[0] === 0x0d)
      if (!startsOnLineBoundary) {
        const firstLineEnd = raw.indexOf("\n")
        raw = firstLineEnd >= 0 ? raw.slice(firstLineEnd + 1) : ""
      }
    }
    return { lines: nonEmptyLines(raw), offset }
  } finally {
    await handle.close()
  }
}

const tailIterator = async function* (
  args: Args,
  pollMs: number,
  abortSignal: { aborted: boolean },
): AsyncIterable<string> {
  const tails: FileTail[] = []
  const seen = new Set<string>()
  const refreshFiles = async () => {
    const files = await collectLedgers(args)
    for (const f of files) {
      if (seen.has(f)) continue
      seen.add(f)
      tails.push({ file: f, offset: 0 })
    }
  }
  await refreshFiles()

  // Initial: emit a bounded suffix of existing contents.
  for (const t of tails) {
    if (!fs.existsSync(t.file)) continue
    const initial = await readInitialTail(t.file)
    t.offset = initial.offset
    for (const line of initial.lines) yield line
  }

  // Follow.
  while (!abortSignal.aborted) {
    await Effect.runPromise(Effect.sleep(`${pollMs} millis`))
    if (abortSignal.aborted) break
    await refreshFiles()
    for (const t of tails) {
      if (!fs.existsSync(t.file)) continue
      const stat = await fsP.stat(t.file)
      if (stat.size <= t.offset) continue
      const fd = await fsP.open(t.file, "r")
      try {
        const len = stat.size - t.offset
        const buf = Buffer.alloc(len)
        await fd.read(buf, 0, len, t.offset)
        t.offset = stat.size
        for (const line of nonEmptyLines(buf.toString("utf8"))) yield line
      } finally {
        await fd.close()
      }
    }
  }
}

interface LedgerLine {
  readonly timestamp?: number | string
  readonly event?: string
  readonly sessionId?: string
  readonly session_id?: string
  readonly data?: unknown
  readonly summary?: string
}

const parseLine = (raw: string): LedgerLine | null => {
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v !== "object" || v === null) return null
    return v as LedgerLine
  } catch {
    return null
  }
}

const isoFromTs = (ts: unknown): string => {
  if (typeof ts === "number") return new Date(ts).toISOString()
  if (typeof ts === "string") {
    const t = Date.parse(ts)
    if (!Number.isNaN(t)) return new Date(t).toISOString()
  }
  return new Date().toISOString()
}

const numericTs = (ts: unknown): number => {
  if (typeof ts === "number") return ts
  if (typeof ts === "string") {
    const t = Date.parse(ts)
    if (!Number.isNaN(t)) return t
  }
  return 0
}

const summarize = (entry: LedgerLine): string => {
  if (typeof entry.summary === "string") return entry.summary
  if (typeof entry.data === "string") return entry.data
  if (entry.data !== undefined && entry.data !== null) {
    try {
      const s = JSON.stringify(entry.data)
      return s.length > 120 ? s.slice(0, 117) + "..." : s
    } catch {
      return ""
    }
  }
  return ""
}

const ANSI_DIM = "\x1b[2m"
const ANSI_BOLD = "\x1b[1m"
const ANSI_RESET = "\x1b[0m"
const ANSI_CYAN = "\x1b[36m"

const prettyPrint = (entry: LedgerLine, color: boolean): string => {
  const iso = isoFromTs(entry.timestamp)
  const sid = (entry.sessionId ?? entry.session_id ?? "") as string
  const sidShort = sid.length > 8 ? sid.slice(0, 8) : sid
  const event = entry.event ?? "?"
  const summary = summarize(entry)
  if (color) {
    return `${ANSI_DIM}[${iso}]${ANSI_RESET} ${ANSI_BOLD}${event}${ANSI_RESET} ${ANSI_CYAN}${sidShort}${ANSI_RESET}: ${summary}`
  }
  return `[${iso}] ${event} ${sidShort}: ${summary}`
}

export const runTail = (
  args: Args,
  opts: { pollMs?: number; color?: boolean } = {},
): Effect.Effect<void> =>
  Effect.scoped(Effect.gen(function* () {
    const pollMs = opts.pollMs ?? 200
    const color = opts.color ?? Boolean(process.stdout.isTTY)
    const abortSignal = { aborted: false }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const onSignal = () => {
          abortSignal.aborted = true
        }
        process.on("SIGINT", onSignal)
        process.on("SIGTERM", onSignal)
        return onSignal
      }),
      (onSignal) =>
        Effect.sync(() => {
          process.removeListener("SIGINT", onSignal)
          process.removeListener("SIGTERM", onSignal)
        }),
    )

    const stream = Stream.fromAsyncIterable(
      tailIterator(args, pollMs, abortSignal),
      (e) => new Error(String(e)),
    ).pipe(
      Stream.map(parseLine),
      Stream.filter((v): v is LedgerLine => v !== null),
      Stream.filter((entry) => {
        if (args.session !== null) {
          const sid = (entry.sessionId ?? entry.session_id) as string | undefined
          if (sid !== undefined && sid !== args.session) return false
        }
        if (args.since !== null) {
          if (numericTs(entry.timestamp) < args.since) return false
        }
        return true
      }),
      Stream.runForEach((entry) =>
        Effect.sync(() => {
          process.stdout.write(prettyPrint(entry, color) + "\n")
        }),
      ),
    )

    yield* stream.pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          process.stderr.write(`[claude-hooks-tail] ${error.message}\n`)
          process.exitCode = 1
        }),
      ),
    )
  }))

// Only run when invoked directly (allows clean import in tests).
const isMain = (() => {
  try {
    const argv1 = process.argv[1] ?? ""
    return argv1.endsWith("/tail.ts") || argv1.endsWith("\\tail.ts")
  } catch {
    return false
  }
})()

if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  await Effect.runPromise(runTail(args))
}
