import { Context, Effect, Layer, Ref } from "effect"

export interface BudgetCheck {
  readonly allowed: boolean
  readonly remaining: number
}

export interface BudgetApi {
  readonly check: (
    key: string,
    cost: number,
    limit: number,
  ) => Effect.Effect<BudgetCheck>
  readonly reset: (key: string) => Effect.Effect<void>
  readonly snapshot: () => Effect.Effect<Readonly<Record<string, number>>>
}

export class Budget extends Context.Tag("Budget")<Budget, BudgetApi>() {}

const makeBudget = (
  initial: Record<string, number> = {},
): Effect.Effect<BudgetApi> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<Record<string, number>>({ ...initial })
    return Budget.of({
      check: (key, cost, limit) =>
        Ref.modify(ref, (state): readonly [BudgetCheck, Record<string, number>] => {
          const used = state[key] ?? 0
          const next = used + cost
          if (next > limit) {
            const denied: BudgetCheck = {
              allowed: false,
              remaining: Math.max(0, limit - used),
            }
            return [denied, state] as const
          }
          const allowed: BudgetCheck = {
            allowed: true,
            remaining: limit - next,
          }
          return [allowed, { ...state, [key]: next }] as const
        }),
      reset: (key) =>
        Ref.update(ref, (state) => {
          const { [key]: _drop, ...rest } = state
          void _drop
          return rest
        }),
      snapshot: () => Ref.get(ref),
    })
  })

export const BudgetLive = Layer.effect(Budget, makeBudget())
export const BudgetTest = (
  initial: Record<string, number> = {},
): Layer.Layer<Budget> => Layer.effect(Budget, makeBudget(initial))
