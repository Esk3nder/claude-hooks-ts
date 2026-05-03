import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as fsP from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
  Approvals,
  ApprovalsLive,
  ApprovalsTest,
  type ApprovalRecord,
  shouldGc,
  GC_INTERVAL_MS,
  DEFAULT_GC_MAX_AGE_MS,
} from "../../src/services/approvals.ts"

const DAY = 24 * 60 * 60 * 1000

const mkRec = (
  cwd: string,
  pattern: string,
  recordedAt: number,
  status: "approved" | "denied" | "pending" = "approved",
): ApprovalRecord => ({ cwd, pattern, status, recordedAt })

describe("Approvals.gc — TestLayer (Ref-backed)", () => {
  test("removes entries older than maxAgeMs, keeps fresh ones, updates last_gc", async () => {
    const cwd = "/repo/a"
    const now = Date.now()
    const old1 = mkRec(cwd, "Bash(ls)", now - 10 * DAY)
    const old2 = mkRec(cwd, "Bash(rm)", now - 8 * DAY, "denied")
    const fresh = mkRec(cwd, "Bash(echo)", now - 1 * 60 * 60 * 1000)
    const otherCwd = mkRec("/repo/b", "Bash(ls)", now - 30 * DAY)
    const layer = ApprovalsTest([old1, old2, fresh, otherCwd])

    const program = Effect.gen(function* () {
      const a = yield* Approvals
      yield* a.gc(cwd, now)
      const stillOld1 = yield* a.lookup(cwd, "Bash(ls)")
      const stillOld2 = yield* a.lookup(cwd, "Bash(rm)")
      const keptFresh = yield* a.lookup(cwd, "Bash(echo)")
      const otherKept = yield* a.lookup("/repo/b", "Bash(ls)")
      return { stillOld1, stillOld2, keptFresh, otherKept }
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r.stillOld1).toBeNull()
    expect(r.stillOld2).toBeNull()
    expect(r.keptFresh?.pattern).toBe("Bash(echo)")
    // gc is scoped to cwd — other cwd's old entry must remain
    expect(r.otherKept?.pattern).toBe("Bash(ls)")
  })
})

describe("Approvals.gc — Live (real filesystem)", () => {
  test("rewrites jsonl removing old entries, writes approvals-meta.json", async () => {
    const tmp = await fsP.mkdtemp(path.join(os.tmpdir(), "approvals-gc-"))
    const stateDir = path.join(tmp, ".claude-hooks", "state")
    await fsP.mkdir(stateDir, { recursive: true })
    const ledger = path.join(stateDir, "approvals.jsonl")
    const meta = path.join(stateDir, "approvals-meta.json")

    const now = Date.now()
    const lines = [
      mkRec(tmp, "Bash(ls)", now - 10 * DAY),
      mkRec(tmp, "Bash(echo)", now - 1 * 60 * 60 * 1000),
      mkRec(tmp, "Bash(pwd)", now - 9 * DAY, "denied"),
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n"
    await fsP.writeFile(ledger, lines, "utf8")

    const program = Effect.gen(function* () {
      const a = yield* Approvals
      yield* a.gc(tmp, now)
    })
    await Effect.runPromise(program.pipe(Effect.provide(ApprovalsLive)))

    const after = await fsP.readFile(ledger, "utf8")
    expect(after).toContain("Bash(echo)")
    expect(after).not.toContain("Bash(ls)")
    expect(after).not.toContain("Bash(pwd)")
    expect(fs.existsSync(meta)).toBe(true)
    const m = JSON.parse(await fsP.readFile(meta, "utf8")) as { last_gc: number }
    expect(m.last_gc).toBe(now)

    await fsP.rm(tmp, { recursive: true, force: true })
  })

  test("custom maxAgeMs respected", async () => {
    const tmp = await fsP.mkdtemp(path.join(os.tmpdir(), "approvals-gc-"))
    const stateDir = path.join(tmp, ".claude-hooks", "state")
    await fsP.mkdir(stateDir, { recursive: true })
    const ledger = path.join(stateDir, "approvals.jsonl")
    const now = Date.now()
    const recs = [
      mkRec(tmp, "old", now - 2 * 60 * 60 * 1000), // 2h old
      mkRec(tmp, "new", now - 10 * 60 * 1000), // 10m old
    ]
    await fsP.writeFile(
      ledger,
      recs.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const a = yield* Approvals
        // 1 hour cutoff
        yield* a.gc(tmp, now, 60 * 60 * 1000)
      }).pipe(Effect.provide(ApprovalsLive)),
    )
    const after = await fsP.readFile(ledger, "utf8")
    expect(after).not.toContain('"pattern":"old"')
    expect(after).toContain('"pattern":"new"')
    await fsP.rm(tmp, { recursive: true, force: true })
  })
})

describe("shouldGc helper", () => {
  test("true when more than 24h since last gc", () => {
    const now = 1_000_000_000_000
    expect(shouldGc(now, now - GC_INTERVAL_MS - 1)).toBe(true)
  })
  test("false when less than 24h since last gc", () => {
    const now = 1_000_000_000_000
    expect(shouldGc(now, now - 60 * 60 * 1000)).toBe(false)
  })
  test("false at exactly 24h boundary (strict greater-than)", () => {
    const now = 1_000_000_000_000
    expect(shouldGc(now, now - GC_INTERVAL_MS)).toBe(false)
  })
})

// keep DEFAULT_GC_MAX_AGE_MS reference live so it's exported and stable
void DEFAULT_GC_MAX_AGE_MS
