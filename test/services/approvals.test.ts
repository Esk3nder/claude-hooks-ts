import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Approvals, ApprovalsTest } from "../../src/services/approvals.ts"

describe("Approvals (test layer)", () => {
  test("lookup returns null for unknown pattern", async () => {
    const program = Effect.gen(function* () {
      const a = yield* Approvals
      return yield* a.lookup("/repo", "Bash:bash:git status")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(ApprovalsTest())))
    expect(r).toBeNull()
  })

  test("seeded approval is returned", async () => {
    const program = Effect.gen(function* () {
      const a = yield* Approvals
      return yield* a.lookup("/repo", "Bash:bash:git status")
    })
    const layer = ApprovalsTest([
      {
        cwd: "/repo",
        pattern: "Bash:bash:git status",
        status: "approved",
        recordedAt: 1,
      },
    ])
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(r?.status).toBe("approved")
  })

  test("record then lookup", async () => {
    const program = Effect.gen(function* () {
      const a = yield* Approvals
      yield* a.record({
        cwd: "/repo",
        pattern: "Edit:path:*.ts",
        status: "denied",
        recordedAt: 5,
      })
      return yield* a.lookup("/repo", "Edit:path:*.ts")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(ApprovalsTest())))
    expect(r?.status).toBe("denied")
  })

  test("latest record wins", async () => {
    const program = Effect.gen(function* () {
      const a = yield* Approvals
      yield* a.record({
        cwd: "/r",
        pattern: "p",
        status: "approved",
        recordedAt: 1,
      })
      yield* a.record({
        cwd: "/r",
        pattern: "p",
        status: "denied",
        recordedAt: 10,
      })
      return yield* a.lookup("/r", "p")
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(ApprovalsTest())))
    expect(r?.status).toBe("denied")
  })
})
