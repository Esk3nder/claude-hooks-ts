import { Context, Effect, Layer } from "effect"
import { DEFAULT_POLICY } from "./policy-config.ts"

export interface RedactApi {
  readonly redact: (input: string) => Effect.Effect<string>
  readonly containsSecret: (input: string) => Effect.Effect<boolean>
}

export class Redact extends Context.Tag("Redact")<Redact, RedactApi>() {}

const makeRedactor = (patterns: ReadonlyArray<RegExp>) => (input: string) => {
  let out = input
  for (const p of patterns) {
    out = out.replace(new RegExp(p.source, p.flags.includes("g") ? p.flags : p.flags + "g"), "[REDACTED]")
  }
  return out
}

const makeChecker = (patterns: ReadonlyArray<RegExp>) => (input: string) =>
  patterns.some((p) => p.test(input))

export const RedactLive = Layer.succeed(
  Redact,
  Redact.of({
    redact: (input) =>
      Effect.sync(() => makeRedactor(DEFAULT_POLICY.secretValuePatterns)(input)),
    containsSecret: (input) =>
      Effect.sync(() => makeChecker(DEFAULT_POLICY.secretValuePatterns)(input)),
  }),
)

export const RedactTest = (
  patterns: ReadonlyArray<RegExp> = DEFAULT_POLICY.secretValuePatterns,
): Layer.Layer<Redact> =>
  Layer.succeed(
    Redact,
    Redact.of({
      redact: (input) => Effect.sync(() => makeRedactor(patterns)(input)),
      containsSecret: (input) =>
        Effect.sync(() => makeChecker(patterns)(input)),
    }),
  )
