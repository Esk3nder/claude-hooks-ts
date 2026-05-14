import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { EventStoreError } from "../../src/schema/errors.ts"
import { Elicitations, ElicitationsLive, ElicitationsLiveBase, ElicitationsTest, elicitationSignature, type ElicitationRecord } from "../../src/services/elicitations.ts"
import { EventStore } from "../../src/services/event-store.ts"
import { FileLockPlatformLive } from "../../src/services/file-lock.ts"

const failingEventStore = (failure: EventStoreError): Layer.Layer<EventStore> =>
  Layer.succeed(
    EventStore,
    EventStore.of({
      append: () => Effect.fail(failure),
      tail: () => Stream.fail(failure),
      compact: () => Effect.fail(failure),
    }),
  )

describe("Elicitations (test layer)", () => {
  test("lookup empty -> null", async () => {
    const r = await Effect.runPromise(Effect.gen(function* () {
      const e = yield* Elicitations
      return yield* e.lookup("/repo", "mcp.foo", "ask", "deadbeef")
    }).pipe(Effect.provide(ElicitationsTest())))
    expect(r).toBeNull()
  })

  test("record + lookup redacts replay content", async () => {
    const sig = elicitationSignature({ prompt: "ok?" })
    const r = await Effect.runPromise(Effect.gen(function* () {
      const e = yield* Elicitations
      yield* e.record("/repo", "mcp.foo", "ask", sig, "accept", { yes: true })
      return yield* e.lookup("/repo", "mcp.foo", "ask", sig)
    }).pipe(Effect.provide(ElicitationsTest())))
    expect(r?.action).toBe("accept")
    expect((r?.content as { redacted?: boolean }).redacted).toBe(true)
    expect(JSON.stringify(r?.content)).not.toContain("yes")
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

  test("event-store failures are summarized without serializing raw causes", async () => {
    const failure = new EventStoreError({
      op: "tail",
      stream: "elicitations:/repo",
      path: "/repo/.claude-hooks/state/elicitations.jsonl",
      message: "event schema decode failed",
      cause: { content: "TOP_SECRET_ELICITATION_CAUSE" },
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const e = yield* Elicitations
        return yield* Effect.either(e.lookup("/repo", "mcp.foo", "ask", "sig"))
      }).pipe(
        Effect.provide(
          Layer.provide(
            ElicitationsLiveBase,
            Layer.merge(failingEventStore(failure), FileLockPlatformLive),
          ),
        ),
      ),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.message).toBe("tail failed for elicitations:/repo: event schema decode failed")
      expect(JSON.stringify(result.left)).not.toContain("TOP_SECRET_ELICITATION_CAUSE")
      expect(JSON.stringify(result.left)).not.toContain("content")
    }
  })
})

describe("ElicitationsLive replay content", () => {
  test("redacts object replay content before persistence", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "elicitations-live-"))
    try {
      const sig = elicitationSignature({ prompt: "ok?" })
      const result = await Effect.runPromise(Effect.gen(function* () {
        const e = yield* Elicitations
        yield* e.record(cwd, "mcp.foo", "ask", sig, "accept", {
          answer: "yes",
          prompt: "do not persist this nested prompt",
        })
        return yield* e.lookup(cwd, "mcp.foo", "ask", sig)
      }).pipe(Effect.provide(ElicitationsLive)))

      expect((result?.content as { redacted?: boolean }).redacted).toBe(true)

      const persisted = await fs.readFile(ledger(cwd), "utf8")
      expect(persisted).toContain("redacted")
      expect(persisted).not.toContain("yes")
      expect(persisted).not.toContain("do not persist this nested prompt")
    } finally {
      await fs.rm(cwd, { recursive: true, force: true })
    }
  })

  test("redacts raw string replay content before persistence", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "elicitations-live-"))
    try {
      const sig = elicitationSignature({ prompt: "ok?" })
      const result = await Effect.runPromise(Effect.gen(function* () {
        const e = yield* Elicitations
        yield* e.record(cwd, "mcp.foo", "ask", sig, "accept", "TOP_SECRET_ELICITATION")
        return yield* e.lookup(cwd, "mcp.foo", "ask", sig)
      }).pipe(Effect.provide(ElicitationsLive)))

      expect((result?.content as { redacted?: boolean }).redacted).toBe(true)

      const persisted = await fs.readFile(ledger(cwd), "utf8")
      expect(persisted).toContain("redacted")
      expect(persisted).not.toContain("TOP_SECRET_ELICITATION")
    } finally {
      await fs.rm(cwd, { recursive: true, force: true })
    }
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

  test("preserves records outside EventStore tail while pruning stale entries", async () => {
    const now = 10_000_000_000
    const oneDay = 24 * 60 * 60 * 1000
    const fresh = Array.from({ length: 1005 }, (_, i): ElicitationRecord => ({
      ts: now - 60 * 1000,
      server: "mcp.foo",
      tool: "ask",
      signature: `sig-fresh-${i}`,
      action: "accept",
      cwd: projectA,
    }))
    const stale: ElicitationRecord = {
      ts: now - 8 * oneDay,
      server: "mcp.foo",
      tool: "ask",
      signature: "sig-stale-tail",
      action: "decline",
      cwd: projectA,
    }
    await seed(projectA, [...fresh, stale])

    await Effect.runPromise(Effect.gen(function* () {
      const api = yield* Elicitations
      yield* api.gc(projectA, now)
    }).pipe(Effect.provide(ElicitationsLive)))

    const remaining = await readAll(projectA)
    expect(remaining.length).toBe(1005)
    expect(remaining.some((r) => r.signature === "sig-fresh-0")).toBe(true)
    expect(remaining.some((r) => r.signature === "sig-stale-tail")).toBe(false)
  })

  test("gc sanitizes retained legacy content even when no records expire", async () => {
    const now = 10_000_000_000
    const record: ElicitationRecord = {
      ts: now - 60 * 1000,
      server: "mcp.foo",
      tool: "ask",
      signature: "sig-legacy-content",
      action: "accept",
      content: {
        answer: "yes",
        prompt: "legacy raw prompt must not survive",
      },
      cwd: projectA,
    }
    await seed(projectA, [record])

    await Effect.runPromise(Effect.gen(function* () {
      const api = yield* Elicitations
      yield* api.gc(projectA, now)
    }).pipe(Effect.provide(ElicitationsLive)))

    const raw = await fs.readFile(ledger(projectA), "utf8")
    expect(raw).toContain("redacted")
    expect(raw).not.toContain("yes")
    expect(raw).not.toContain("legacy raw prompt must not survive")
  })
})
