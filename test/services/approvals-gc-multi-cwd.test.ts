import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  Approvals,
  ApprovalsLive,
  type ApprovalRecord,
} from "../../src/services/approvals.ts"

let projectA: string
let projectB: string

const ledger = (cwd: string) =>
  path.join(cwd, ".claude-hooks", "state", "approvals.jsonl")

const seed = async (
  cwd: string,
  records: ReadonlyArray<ApprovalRecord>,
): Promise<void> => {
  const file = ledger(cwd)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n"
  await fs.writeFile(file, body, "utf8")
}

const readAll = async (cwd: string): Promise<ApprovalRecord[]> => {
  const file = ledger(cwd)
  if (!fsSync.existsSync(file)) return []
  const raw = await fs.readFile(file, "utf8")
  return raw
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as ApprovalRecord)
}

beforeEach(async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "approvals-gc-"))
  projectA = path.join(tmpRoot, "project-a")
  projectB = path.join(tmpRoot, "project-b")
  await fs.mkdir(projectA, { recursive: true })
  await fs.mkdir(projectB, { recursive: true })
})

afterEach(async () => {
  for (const p of [projectA, projectB]) {
    try {
      await fs.rm(path.dirname(p), { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

describe("Approvals.gc — cwd scoping (Live impl)", () => {
  test("only prunes stale records from the target cwd; preserves other cwds", async () => {
    const now = 10_000_000
    const oneDay = 24 * 60 * 60 * 1000
    const tenDaysAgo = now - 10 * oneDay
    const oneHourAgo = now - 60 * 60 * 1000

    const oldA: ApprovalRecord = {
      cwd: projectA,
      pattern: "rm -rf *",
      status: "approved",
      recordedAt: tenDaysAgo,
    }
    const freshA: ApprovalRecord = {
      cwd: projectA,
      pattern: "ls",
      status: "approved",
      recordedAt: oneHourAgo,
    }
    // Project B's records share the *same* ledger dir on disk only because
    // approvals.jsonl is per-cwd. The bug shows up when both share one ledger
    // — which the Live impl can do if a caller writes B's records into A's
    // ledger (e.g. shared global ledger in monorepo). Simulate by seeding
    // A's ledger with B's records too.
    const oldB: ApprovalRecord = {
      cwd: projectB,
      pattern: "git push",
      status: "approved",
      recordedAt: tenDaysAgo,
    }
    const freshB: ApprovalRecord = {
      cwd: projectB,
      pattern: "git status",
      status: "approved",
      recordedAt: oneHourAgo,
    }

    await seed(projectA, [oldA, freshA, oldB, freshB])

    await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* Approvals
        yield* api.gc(projectA, now)
      }).pipe(Effect.provide(ApprovalsLive)),
    )

    const remaining = await readAll(projectA)
    // Old A pruned, fresh A kept, both B records preserved (other cwd).
    const matchA = remaining.filter((r) => r.cwd === projectA)
    const matchB = remaining.filter((r) => r.cwd === projectB)

    expect(matchA.length).toBe(1)
    expect(matchA[0]!.pattern).toBe("ls")
    expect(matchB.length).toBe(2)
    expect(matchB.map((r) => r.pattern).sort()).toEqual(
      ["git push", "git status"].sort(),
    )
  })
})
