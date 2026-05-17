import { Context, Effect, Layer, Metric, Option, Ref } from "effect"
import type { HookDecision } from "../schema/decisions.ts"
import { Ledger, type LedgerEntry } from "./ledger.ts"
import { DEFAULT_POLICY } from "./policy-config.ts"

export type HookFailureKind =
  | "stdin_empty"
  | "json_parse_failed"
  | "payload_decode_failed"
  | "handler_timeout"
  | "handler_failed"
  | "decision_encode_failed"
  | "state_read_failed"
  | "state_write_failed"
  | "ledger_append_failed"
  | "subprocess_failed"
  | "worker_enqueue_failed"

export interface HookFailureInput {
  readonly kind: HookFailureKind
  readonly event?: string | null | undefined
  readonly sessionId?: string | null | undefined
  readonly cause: unknown
  readonly fallbackDecision?: HookDecision | undefined
  readonly hookSafe: boolean
  readonly context?: Readonly<Record<string, unknown>> | undefined
  readonly ledger?: boolean | undefined
}

export interface HookFailureRecord {
  readonly timestamp: string
  readonly kind: HookFailureKind
  readonly event: string | null
  readonly sessionId: string | null
  readonly cause: string
  readonly fallbackDecision: unknown
  readonly hookSafe: boolean
  readonly context: Readonly<Record<string, unknown>>
}

export interface HookFailureApi {
  readonly report: (input: HookFailureInput) => Effect.Effect<void>
}

export class HookFailure extends Context.Tag("HookFailure")<
  HookFailure,
  HookFailureApi
>() {}

const hookFailureCounter = Metric.counter("hook_failures_total", {
  description: "Claude hook failures and hook-safe fallbacks by kind/event.",
  incremental: true,
})

const secretKeyRe = /(secret|token|key|password|credential|authorization|auth)/i
const secretValuePatterns = DEFAULT_POLICY.secretValuePatterns.map(
  (pattern) =>
    new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    ),
)

const redactCauseText = (value: string): string => {
  let out = value
  for (const pattern of secretValuePatterns) {
    pattern.lastIndex = 0
    out = out.replace(pattern, "[REDACTED]")
  }
  return out
}

const stringField = (cause: Record<string, unknown>, key: string): string | null => {
  const value = cause[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

const summarizeCause = (cause: unknown): string => {
  if (cause instanceof Error) {
    const message = cause.message.length > 0 ? cause.message : cause.name
    return redactCauseText(`${cause.name}: ${message}`).slice(0, 300)
  }
  if (typeof cause === "string") return redactCauseText(cause).slice(0, 300)
  if (typeof cause === "object" && cause !== null) {
    const record = cause as Record<string, unknown>
    const tag = stringField(record, "_tag") ?? stringField(record, "name")
    const message = stringField(record, "message") ?? stringField(record, "reason")
    if (tag !== null && message !== null) {
      return redactCauseText(`${tag}: ${message}`).slice(0, 300)
    }
    if (message !== null) return redactCauseText(message).slice(0, 300)
    if (tag !== null) return redactCauseText(tag).slice(0, 300)
    return "non-error object cause"
  }
  return String(cause).slice(0, 300)
}

const redactValue = (key: string, value: unknown): unknown => {
  if (secretKeyRe.test(key)) return "[REDACTED]"
  if (typeof value === "string") return value.slice(0, 300)
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value
  }
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value).slice(0, 300)
  } catch {
    return String(value).slice(0, 300)
  }
}

export const redactFailureContext = (
  context: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(context)) {
    const redacted = redactValue(key, value)
    if (redacted !== undefined) out[key] = redacted
  }
  return out
}

const decisionSummary = (decision: HookDecision | undefined): unknown => {
  if (decision === undefined) return null
  if (Object.keys(decision).length === 0) return {}
  const hso = (decision as { hookSpecificOutput?: unknown }).hookSpecificOutput
  if (typeof hso === "object" && hso !== null) {
    const o = hso as {
      hookEventName?: unknown
      permissionDecision?: unknown
      decision?: unknown
      reason?: unknown
      permissionDecisionReason?: unknown
    }
    return {
      hookEventName: o.hookEventName,
      permissionDecision: o.permissionDecision,
      decision: o.decision,
      reason: typeof o.reason === "string" ? o.reason.slice(0, 160) : undefined,
      permissionDecisionReason:
        typeof o.permissionDecisionReason === "string"
          ? o.permissionDecisionReason.slice(0, 160)
          : undefined,
    }
  }
  return decision
}

const makeRecord = (input: HookFailureInput): HookFailureRecord => ({
  timestamp: new Date().toISOString(),
  kind: input.kind,
  event: input.event ?? null,
  sessionId: input.sessionId ?? null,
  cause: summarizeCause(input.cause),
  fallbackDecision: decisionSummary(input.fallbackDecision),
  hookSafe: input.hookSafe,
  context: redactFailureContext(input.context),
})

const annotationsFor = (record: HookFailureRecord): Record<string, unknown> => ({
  fallback_kind: record.kind,
  event: record.event ?? "unknown",
  session_id: record.sessionId ?? "unknown",
  hook_safe: record.hookSafe,
  ...(typeof record.context["tool_name"] === "string"
    ? { tool_name: record.context["tool_name"] }
    : {}),
  ...(typeof record.context["cwd"] === "string"
    ? { cwd: record.context["cwd"] }
    : {}),
})

const metricFor = (record: HookFailureRecord) =>
  Metric.tagged(
    Metric.tagged(hookFailureCounter, "kind", record.kind),
    "event",
    record.event ?? "unknown",
  )

export const HookFailureLive: Layer.Layer<HookFailure> = Layer.succeed(
  HookFailure,
  HookFailure.of({
    report: (input) =>
      Effect.gen(function* () {
        const record = makeRecord(input)
        const annotations = annotationsFor(record)
        yield* Metric.increment(metricFor(record))
        yield* Effect.annotateCurrentSpan({
          ...annotations,
          failure_cause: record.cause,
        })
        yield* Effect.logWarning("hook_failure", record).pipe(
          Effect.annotateLogs(annotations),
        )
        if (input.ledger !== true || record.sessionId === null) return
        const ledger = yield* Effect.serviceOption(Ledger)
        if (Option.isNone(ledger)) return
        const entry: LedgerEntry = {
          timestamp: Date.now(),
          event: "HookFailure",
          sessionId: record.sessionId,
          data: record,
        }
        yield* ledger.value.append(entry).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      }).pipe(Effect.catchAll(() => Effect.succeed(undefined))),
  }),
)

export const reportHookFailure = (
  input: HookFailureInput,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const service = yield* Effect.serviceOption(HookFailure)
    if (Option.isSome(service)) return yield* service.value.report(input)
    const record = makeRecord(input)
    const annotations = annotationsFor(record)
    yield* Metric.increment(metricFor(record))
    yield* Effect.annotateCurrentSpan({
      ...annotations,
      failure_cause: record.cause,
    })
    yield* Effect.logWarning("hook_failure", record).pipe(
      Effect.annotateLogs(annotations),
    )
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

export const HookFailureTest = (): {
  readonly layer: Layer.Layer<HookFailure>
  readonly records: () => ReadonlyArray<HookFailureRecord>
} => {
  const captured: HookFailureRecord[] = []
  const layer = Layer.effect(
    HookFailure,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ReadonlyArray<HookFailureRecord>>([])
      return HookFailure.of({
        report: (input) =>
          Effect.gen(function* () {
            const record = makeRecord(input)
            yield* Ref.update(ref, (xs) => [...xs, record])
            captured.push(record)
            yield* Metric.increment(metricFor(record))
          }),
      })
    }),
  )
  return { layer, records: () => captured }
}
