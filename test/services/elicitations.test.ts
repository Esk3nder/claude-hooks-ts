import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Elicitations, ElicitationsLive, ElicitationsTest, elicitationSignature, type ElicitationRecord } from "../../src/services/elicitations.ts"

describe("Elicitations (test layer)", () => {
  test("lookup empty -> null", async () => {
    const r = await Effect.runPromise(Effect.gen(function* () {
      const e = yield* Elicitations
      return yield* e.lookup("/repo", "mcp.foo", "ask", "deadbeef")
    }).pipe(Effect.provide(ElicitationsTest())))
    expect(r).toBeNull()
  })

  test("record + lookup roundtrip", async () => {
    const sig = elicitationSignature({ prompt: "ok?" })
    const r = await Effect.runPromise(Effect.gen(function* () {
      const e = yield* Elicitations
      yield* e.record("/repo", "mcp.foo", "ask", sig, "accept", { yes: true })
      return yield* e.lookup("/repo", "mcp.foo", "ask", sig)
    }).pipe(Effect.provide(ElicitationsTest())))
    expect(r?.action).toBe("accept")
    expect((r?.content as { yes: boolean }).yes).toBe(true)
  })

  test("pending request roundtrip", async () => {
    const sig = elicitationSignature({ prompt: "ok?" })
    const r = await Effect.runPromise(Effect.gen(function* () {
      const e = yield* Elicitations
      yield* e.recordPending("s1", "/repo", "mcp.foo", "ask", sig)
      return yield* e.findLatestPending("s1", "/repo", "mcp.foo", "ask")
    }).pipe(Effect.provide(ElicitationsTest())))
    expect(r?.requestSignature).toBe(sig)
  })
})

let projectA: string
let projectB: string
const ledger = (cwd: string) => path.join(cwd, ".claude-hooks", "state", "elicitations.jsonl")

const seed = async (cwd: string, records: ReadonlyArray<ElicitationRecord>): Promise<void> => {
  const file = ledger(cwd)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8")
}

const readAll = async (cwd: string): Promise<ElicitationRecord[]> => {
  const file = ledger(cwd)
  if (!fsSync.existsSync(file)) return []
  const raw = await fs.readFile(file, "utf8")
  return raw.split(/\r?\n/).filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as ElicitationRecord)
}

describe("Elicitations.gc (Live impl)", () => {
  beforeEach(async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "elicitations-gc-"))
    projectA = path.join(tmpRoot, "project-a")
    projectB = path.join(tmpRoot, "project-b")
    await fs.mkdir(projectA, { recursive: true })
    await fs.mkdir(projectB, { recursive: true })
  })
  afterEach(async () => {
    for (const p of [projectA, projectB]) {
      try { await fs.rm(path.dirname(p), { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  test("removes 8d-old, keeps 1h-old; preserves other-cwd entries", async () => {
    const now = 10_000_000_000
    const oneDay = 24 * 60 * 60 * 1000
    const eightDaysAgo = now - 8 * oneDay
    const oneHourAgo = now - 60 * 60 * 1000
    const oldA: ElicitationRecord = { ts: eightDaysAgo, server: "mcp.foo", tool: "ask", signature: "sig-old-a", action: "accept", content: null, cwd: projectA }
    const freshA: ElicitationRecord = { ts: oneHourAgo, server: "mcp.foo", tool: "ask", signature: "sig-fresh-a", action: "decline", cwd: projectA }
    const oldB: ElicitationRecord = { ts: eightDaysAgo, server: "mcp.bar", tool: "ask", signature: "sig-old-b", action: "accept", cwd: projectB }
    const freshB: ElicitationRecord = { ts: oneHourAgo, server: "mcp.bar", tool: "ask", signature: "sig-fresh-b", action: "accept", cwd: projectB }
    await seed(projectA, [oldA, freshA, oldB, freshB])
    await Effect.runPromise(Effect.gen(function* () {
      const api = yield* Elicitations
      yield* api.gc(projectA, now)
    }).pipe(Effect.provide(ElicitationsLive)))
    const remaining = await readAll(projectA)
    const matchA = remaining.filter((r) => r.cwd === projectA)
    const matchB = remaining.filter((r) => r.cwd === projectB)
    expect(matchA.length).toBe(1)
    expect(matchA[0]!.signature).toBe("sig-fresh-a")
    expect(matchB.length).toBe(2)
  })
})
