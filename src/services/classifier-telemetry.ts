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
 * Failure policy: best-effort. A failed EventStore append must NEVER block
 * the hook response.
 */

import { Context, Effect, Layer } from "effect"
import * as crypto from "node:crypto"
import * as path from "node:path"
import { ClassifierTelemetryRecordSchema, eventStream } from "../schema/events.ts"
import { EventStore, EventStoreLive, summarizeEventStoreError } from "./event-store.ts"
import { logWarning } from "./diagnostics.ts"
import type { Mode, Tier, ClassificationSource } from "./inference.ts"

export interface ClassifierTelemetryRecord {
  /** ISO 8601 timestamp. */
  readonly timestamp: string
  readonly session_id: string
  /** SHA-256 digest prefix of the prompt; avoids logging prompt contents. */
  readonly prompt_hash: string
  /** Kept for backward-compatible shape; intentionally empty to avoid leaks. */
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

/** Build a stable prompt hash without logging prompt contents. */
export const buildPromptHash = (prompt: string): string =>
  crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16)

/** Build the prompt_excerpt field. Intentionally blank for local-secret safety. */
export const buildPromptExcerpt = (_prompt: string): string => ""

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
  prompt_hash: buildPromptHash(input.prompt),
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

const classifierTelemetryStream = (root: string) =>
  eventStream("classifier-telemetry", telemetryPath(root), ClassifierTelemetryRecordSchema, {
    maxRecords: 5_000,
  })

/**
 * Live impl — appends a JSON line to the destination file. implements canonical behavior
 * defensive "skip if serialization contains a newline" guard so a single
 * malformed record can't corrupt downstream JSONL parsers.
 */
export const ClassifierTelemetryLive = (
  root: string = process.cwd(),
): Layer.Layer<ClassifierTelemetry> =>
  Layer.provide(ClassifierTelemetryLiveBase(root), EventStoreLive)

export const ClassifierTelemetryLiveBase = (
  root: string = process.cwd(),
): Layer.Layer<ClassifierTelemetry, never, EventStore> =>
  Layer.effect(
    ClassifierTelemetry,
    Effect.gen(function* () {
      const store = yield* EventStore
      const stream = classifierTelemetryStream(root)
      return ClassifierTelemetry.of({
        append: (record) =>
          store.append(stream, record).pipe(
            Effect.catchAll((err) =>
              logWarning(`classifier-telemetry: append failed: ${summarizeEventStoreError(err)}`),
            ),
          ),
      })
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
