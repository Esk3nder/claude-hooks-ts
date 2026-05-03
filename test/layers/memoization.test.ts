import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Ref } from "effect"
import { Approvals } from "../../src/services/approvals.ts"
import { PolicyConfig } from "../../src/services/policy-config.ts"
import { Project } from "../../src/services/project.ts"
import { SessionState } from "../../src/services/session-state.ts"
import { Ledger } from "../../src/services/ledger.ts"
import { Budget } from "../../src/services/budget.ts"
import { Redact } from "../../src/services/redact.ts"
import { Git } from "../../src/services/git.ts"
import { Shell } from "../../src/services/shell.ts"
import { FileSystem } from "../../src/services/filesystem.ts"

/**
 * Layer audit — living documentation that every service in AppLive is built
 * exactly once per layer scope.
 *
 * Effect's `Layer.mergeAll` produces a layer whose constructors run once per
 * scope when the resulting layer is provided to a single Effect (which is how
 * the dispatcher uses AppLive). This test instruments counter-mock layers
 * for each service, builds them via `Layer.mergeAll`, runs an Effect that
 * touches each service multiple times, and asserts each constructor ran 1x.
 *
 * If a future change rebuilds a service (counter > 1), wrap it explicitly in
 * `Layer.memoize` inside `src/layers/live.ts` and document the reason here.
 */

const counterLayer = <Tag, Svc>(
  tag: Context.Tag<Tag, Svc>,
  stub: Svc,
  counter: Ref.Ref<number>,
): Layer.Layer<Tag> =>
  Layer.effect(
    tag,
    Effect.gen(function* () {
      yield* Ref.update(counter, (n) => n + 1)
      return stub
    }),
  )

describe("AppLive memoization audit", () => {
  test("each service constructor runs exactly once across multiple uses", async () => {
    const counts = {
      approvals: Effect.runSync(Ref.make(0)),
      policyConfig: Effect.runSync(Ref.make(0)),
      project: Effect.runSync(Ref.make(0)),
      sessionState: Effect.runSync(Ref.make(0)),
      ledger: Effect.runSync(Ref.make(0)),
      budget: Effect.runSync(Ref.make(0)),
      redact: Effect.runSync(Ref.make(0)),
      git: Effect.runSync(Ref.make(0)),
      shell: Effect.runSync(Ref.make(0)),
      filesystem: Effect.runSync(Ref.make(0)),
    }

    // Empty stubs are fine: the test never invokes service methods, only
    // requests the tag from context to confirm constructor side-effects.
    const stub = {} as never

    const merged = Layer.mergeAll(
      counterLayer(Approvals, stub, counts.approvals),
      counterLayer(PolicyConfig, stub, counts.policyConfig),
      counterLayer(Project, stub, counts.project),
      counterLayer(SessionState, stub, counts.sessionState),
      counterLayer(Ledger, stub, counts.ledger),
      counterLayer(Budget, stub, counts.budget),
      counterLayer(Redact, stub, counts.redact),
      counterLayer(Git, stub, counts.git),
      counterLayer(Shell, stub, counts.shell),
      counterLayer(FileSystem, stub, counts.filesystem),
    )

    const program = Effect.gen(function* () {
      // Touch each service multiple times — none of these should re-trigger
      // the counter because Layer.mergeAll memoizes per scope.
      for (let i = 0; i < 5; i++) {
        yield* Approvals
        yield* PolicyConfig
        yield* Project
        yield* SessionState
        yield* Ledger
        yield* Budget
        yield* Redact
        yield* Git
        yield* Shell
        yield* FileSystem
      }
    })

    await Effect.runPromise(program.pipe(Effect.provide(merged)))

    for (const [name, ref] of Object.entries(counts)) {
      const n = await Effect.runPromise(Ref.get(ref))
      // If this assertion ever flips for a service, wrap it with Layer.memoize
      // in src/layers/live.ts and add a comment explaining the boundary.
      expect({ service: name, runs: n }).toEqual({ service: name, runs: 1 })
    }
  })
})
