import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Shell, ShellTest } from "../../src/services/shell.ts"
import { Git, GitTest } from "../../src/services/git.ts"
import { Project, ProjectTest } from "../../src/services/project.ts"
import { PolicyConfig, PolicyConfigTest, DEFAULT_POLICY } from "../../src/services/policy-config.ts"
import { Ledger, LedgerTest } from "../../src/services/ledger.ts"
import { Redact, RedactTest } from "../../src/services/redact.ts"
import { Budget, BudgetTest } from "../../src/services/budget.ts"
import { makeShellCommand } from "../../src/schema/branded.ts"
import { Either } from "effect"

describe("Shell test layer", () => {
  test("returns canned response", async () => {
    const cmd = makeShellCommand("echo", ["x"])
    expect(Either.isRight(cmd)).toBe(true)
    if (!Either.isRight(cmd)) return
    const layer = ShellTest(() => ({ stdout: "ok", stderr: "", exitCode: 0 }))
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Shell, (s) => s.run(cmd.right)),
        layer,
      ),
    )
    expect(r).toEqual({ stdout: "ok", stderr: "", exitCode: 0 })
  })
})

describe("Git test layer", () => {
  test("returns canned branch", async () => {
    const layer = GitTest({ branch: "feat/x", dirty: true, sha: "abc" })
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const g = yield* Git
          return {
            b: yield* g.currentBranch(),
            d: yield* g.isDirty(),
            s: yield* g.headSha(),
          }
        }),
        layer,
      ),
    )
    expect(r).toEqual({ b: "feat/x", d: true, s: "abc" })
  })
})

describe("Project test layer", () => {
  test("returns null commands by default", async () => {
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Project, (p) => p.testCommand("targeted")),
        ProjectTest(),
      ),
    )
    expect(r).toBeNull()
  })

  test("returns configured command", async () => {
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Project, (p) => p.typecheckCommand()),
        ProjectTest({ typecheck: "bun run typecheck" }),
      ),
    )
    expect(r).toBe("bun run typecheck")
  })
})

describe("PolicyConfig", () => {
  test("baked-in defaults present", async () => {
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(PolicyConfig, (p) => p.load()),
        PolicyConfigTest(),
      ),
    )
    expect(r.destructiveCommandPatterns.length).toBeGreaterThan(0)
    expect(r.secretPathGlobs.length).toBeGreaterThan(0)
    expect(DEFAULT_POLICY.destructiveCommandPatterns.some((re) => re.test("rm -rf /"))).toBe(true)
  })
})

describe("Ledger test layer", () => {
  test("append + read", async () => {
    const layer = LedgerTest()
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const l = yield* Ledger
          yield* l.append({ timestamp: 1, event: "x", sessionId: "s", data: 1 })
          yield* l.append({ timestamp: 2, event: "y", sessionId: "t", data: 2 })
          return yield* l.read("s")
        }),
        layer,
      ),
    )
    expect(r.length).toBe(1)
    expect(r[0]!.event).toBe("x")
  })
})

describe("Redact", () => {
  test("redacts known secret pattern", async () => {
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Redact, (s) => s.redact("token: sk-abcdefghijklmnopqrstuvwx end")),
        RedactTest(),
      ),
    )
    expect(r).toContain("[REDACTED]")
    expect(r).not.toContain("sk-abcdef")
  })
  test("containsSecret returns false on clean input", async () => {
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Redact, (s) => s.containsSecret("nothing here")),
        RedactTest(),
      ),
    )
    expect(r).toBe(false)
  })
})

describe("Budget", () => {
  test("denies after exceeding limit", async () => {
    const layer = BudgetTest()
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const b = yield* Budget
          const a1 = yield* b.check("k", 5, 10)
          const a2 = yield* b.check("k", 4, 10)
          const a3 = yield* b.check("k", 2, 10)
          return [a1, a2, a3]
        }),
        layer,
      ),
    )
    expect(r[0]!.allowed).toBe(true)
    expect(r[1]!.allowed).toBe(true)
    expect(r[2]!.allowed).toBe(false)
  })
})
