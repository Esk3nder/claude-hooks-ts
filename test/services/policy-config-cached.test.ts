import { describe, expect, test } from "bun:test"
import { Effect, Ref } from "effect"
import {
  PolicyConfig,
  PolicyConfigCachedFromLoader,
  DEFAULT_POLICY,
  type PolicyConfigData,
} from "../../src/services/policy-config.ts"
import {
  Project,
  ProjectCachedFromLoaders,
} from "../../src/services/project.ts"

describe("PolicyConfig — Effect.cached on hot reads", () => {
  test("load() called 10x runs underlying loader exactly once", async () => {
    const counter = Effect.runSync(Ref.make(0))
    const loader: Effect.Effect<PolicyConfigData> = Effect.gen(function* () {
      yield* Ref.update(counter, (n) => n + 1)
      return DEFAULT_POLICY
    })
    const layer = PolicyConfigCachedFromLoader(loader)
    const program = Effect.gen(function* () {
      const cfg = yield* PolicyConfig
      const out: PolicyConfigData[] = []
      for (let i = 0; i < 10; i++) {
        out.push(yield* cfg.load())
      }
      return out
    })
    const results = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(results).toHaveLength(10)
    const callCount = await Effect.runPromise(Ref.get(counter))
    expect(callCount).toBe(1)
    // All references identical (same cached value)
    for (const r of results) expect(r).toBe(results[0]!)
  })
})

describe("Project — Effect.cached on hot reads", () => {
  test("typecheckCommand 10x => loader runs once", async () => {
    const tcCount = Effect.runSync(Ref.make(0))
    const lintCount = Effect.runSync(Ref.make(0))
    const ttCount = Effect.runSync(Ref.make(0))
    const tfCount = Effect.runSync(Ref.make(0))
    const rootCount = Effect.runSync(Ref.make(0))
    const layer = ProjectCachedFromLoaders({
      root: Effect.gen(function* () {
        yield* Ref.update(rootCount, (n) => n + 1)
        return "/proj"
      }),
      typecheck: Effect.gen(function* () {
        yield* Ref.update(tcCount, (n) => n + 1)
        return "bun run typecheck"
      }),
      lint: Effect.gen(function* () {
        yield* Ref.update(lintCount, (n) => n + 1)
        return "bun run lint"
      }),
      testTargeted: Effect.gen(function* () {
        yield* Ref.update(ttCount, (n) => n + 1)
        return "bun test --changed"
      }),
      testFull: Effect.gen(function* () {
        yield* Ref.update(tfCount, (n) => n + 1)
        return "bun test"
      }),
    })
    const program = Effect.gen(function* () {
      const p = yield* Project
      for (let i = 0; i < 10; i++) {
        yield* p.typecheckCommand()
        yield* p.lintCommand()
        yield* p.testCommand("targeted")
        yield* p.testCommand("full")
        yield* p.root()
      }
    })
    await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(await Effect.runPromise(Ref.get(tcCount))).toBe(1)
    expect(await Effect.runPromise(Ref.get(lintCount))).toBe(1)
    expect(await Effect.runPromise(Ref.get(ttCount))).toBe(1)
    expect(await Effect.runPromise(Ref.get(tfCount))).toBe(1)
    expect(await Effect.runPromise(Ref.get(rootCount))).toBe(1)
  })
})
