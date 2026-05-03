import { Context, Effect, Layer } from "effect"
import { DEFAULT_POLICY } from "./policy-config.ts"

export interface RedactApi {
  readonly redact: (input: string) => Effect.Effect<string>
  readonly containsSecret: (input: string) => Effect.Effect<boolean>
}

export class Redact extends Context.Tag("Redact")<Redact, RedactApi>() {}

/**
 * Precompile patterns once. For redaction we need a global flag to replace
 * all matches; for detection we keep the original (which may not be global).
 */
const compileRedactPatterns = (
  patterns: ReadonlyArray<RegExp>,
): ReadonlyArray<RegExp> =>
  patterns.map(
    (p) =>
      new RegExp(p.source, p.flags.includes("g") ? p.flags : p.flags + "g"),
  )

const DEFAULT_REDACT_PATTERNS: ReadonlyArray<RegExp> = compileRedactPatterns(
  DEFAULT_POLICY.secretValuePatterns,
)
// Use the same compiled patterns for detection so check and redact have
// identical semantics (e.g. global flag stays consistent).
const DEFAULT_CHECK_PATTERNS: ReadonlyArray<RegExp> = compileRedactPatterns(
  DEFAULT_POLICY.secretValuePatterns,
)

const redactWith = (patterns: ReadonlyArray<RegExp>, input: string): string => {
  let out = input
  for (const p of patterns) {
    // Reset stateful regexes so .replace works deterministically across calls.
    p.lastIndex = 0
    out = out.replace(p, "[REDACTED]")
  }
  return out
}

const checkWith = (patterns: ReadonlyArray<RegExp>, input: string): boolean => {
  for (const p of patterns) {
    p.lastIndex = 0
    if (p.test(input)) return true
  }
  return false
}

export const RedactLive = Layer.succeed(
  Redact,
  Redact.of({
    redact: (input) =>
      Effect.sync(() => redactWith(DEFAULT_REDACT_PATTERNS, input)),
    containsSecret: (input) =>
      Effect.sync(() => checkWith(DEFAULT_CHECK_PATTERNS, input)),
  }),
)

export const RedactTest = (
  patterns: ReadonlyArray<RegExp> = DEFAULT_POLICY.secretValuePatterns,
): Layer.Layer<Redact> => {
  const redactPatterns = compileRedactPatterns(patterns)
  const checkPatterns = compileRedactPatterns(patterns)
  return Layer.succeed(
    Redact,
    Redact.of({
      redact: (input) => Effect.sync(() => redactWith(redactPatterns, input)),
      containsSecret: (input) =>
        Effect.sync(() => checkWith(checkPatterns, input)),
    }),
  )
}
