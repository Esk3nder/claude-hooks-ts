/**
 * Mode-classifier telemetry sink — implements canonical behavior appendPromptProcessingTelemetry
 * (the classifier rubric) and the Algorithm v6.3.0:
 * "Every classification is logged… Audit weekly: classifier-vs-fail-safe
 * ratio, average latency, downstream override rate."
 *
 * Record shape implements the classifier / 1018-1024 — same field names so
 * downstream auditors that grew up on this package's JSONL can read this file too.
 *
 * Destination: `<project>/.claude-hooks/state/observability/mode-classifier.jsonl`
 * (under the package's existing state root, not under MEMORY/OBSERVABILITY
 * which is a this package-specific path).
 *
 * Failure policy: best-effort. A failed write must NEVER block the hook
 * response. implements canonical behavior empty try/catch around the appendFileSync call.
 */

import { Context, Effect, Layer } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { Mode, Tier, ClassificationSource } from "./inference.ts"

export interface ClassifierTelemetryRecord {
  /** ISO 8601 timestamp. */
  readonly timestamp: string
  readonly session_id: string
  /** First 120 chars of the user prompt — matches the prompt_excerpt slice. */
  readonly prompt_excerpt: string
  readonly mode: Mode
  readonly tier: Tier | null
  readonly mode_reason: string
  readonly source: ClassificationSource
  readonly latency_ms: number
}

export interface ClassifierTelemetryApi {
  readonly append: (record: ClassifierTelemetryRecord) => Effect.Effect<void>
}

export class ClassifierTelemetry extends Context.Tag("ClassifierTelemetry")<
  ClassifierTelemetry,
  ClassifierTelemetryApi
>() {}

/** Build the prompt_excerpt the same way this package does. */
export const buildPromptExcerpt = (prompt: string): string =>
  prompt.slice(0, 120)

/** Build a single record. Used by the prompt-router and by tests. */
export const buildRecord = (input: {
  readonly sessionId: string
  readonly prompt: string
  readonly mode: Mode
  readonly tier: Tier | null
  readonly modeReason: string
  readonly source: ClassificationSource
  readonly latencyMs: number
}): ClassifierTelemetryRecord => ({
  timestamp: new Date().toISOString(),
  session_id: input.sessionId,
  prompt_excerpt: buildPromptExcerpt(input.prompt),
  mode: input.mode,
  tier: input.tier,
  mode_reason: input.modeReason,
  source: input.source,
  latency_ms: input.latencyMs,
})

const telemetryPath = (root: string): string =>
  path.join(
    root,
    ".claude-hooks",
    "state",
    "observability",
    "mode-classifier.jsonl",
  )

/**
 * Live impl — appends a JSON line to the destination file. implements canonical behavior
 * defensive "skip if serialization contains a newline" guard so a single
 * malformed record can't corrupt downstream JSONL parsers.
 */
export const ClassifierTelemetryLive = (
  root: string = process.cwd(),
): Layer.Layer<ClassifierTelemetry> =>
  Layer.succeed(
    ClassifierTelemetry,
    ClassifierTelemetry.of({
      append: (record) =>
        Effect.tryPromise({
          try: async () => {
            const serialized = JSON.stringify(record)
            // the classifier: skip if serialization contains a literal newline
            // (defensive — some prompt_excerpt values could carry one).
            if (serialized.includes("\n")) return
            const file = telemetryPath(root)
            await fs.mkdir(path.dirname(file), { recursive: true })
            await fs.appendFile(file, `${serialized}\n`, "utf8")
          },
          catch: () => undefined,
        }).pipe(Effect.catchAll(() => Effect.succeed(undefined))),
    }),
  )

/**
 * Test layer — captures records into an in-memory array exposed via the
 * factory's `records` getter so tests can assert what was logged.
 */
export const ClassifierTelemetryTest = (): {
  readonly layer: Layer.Layer<ClassifierTelemetry>
  readonly records: () => ReadonlyArray<ClassifierTelemetryRecord>
} => {
  const captured: ClassifierTelemetryRecord[] = []
  const layer = Layer.succeed(
    ClassifierTelemetry,
    ClassifierTelemetry.of({
      append: (record) =>
        Effect.sync(() => {
          captured.push(record)
        }),
    }),
  )
  return { layer, records: () => captured }
}
