import { Context, Duration, Effect, Layer, Option, Redacted } from "effect"
import type { EnvMap } from "../bootstrap/env.ts"
import { currentProcessEnv } from "../bootstrap/env.ts"

export interface RuntimeConfig {
  readonly defaultHandlerTimeoutMs: Duration.Duration
  readonly stopTimeoutMs: Duration.Duration
  readonly userPromptSubmitTimeoutMs: Duration.Duration
  readonly classifierTimeoutMs: Duration.Duration
  readonly classifierDisabled: boolean
  readonly isaPretoolGateDisabled: boolean
  /** US-1: opt-in PreToolUse TDD gate. When true, Write/Edit on non-test
   * `src/**` files is blocked unless a companion test exists on disk or
   * was touched in this session. Default false (opt-in). */
  readonly tddGateEnabled: boolean
  readonly otelEndpoint: Option.Option<Redacted.Redacted<string>>
  readonly lockRetryTimeoutMs: Duration.Duration
  readonly approvalGcInterval: Duration.Duration
  readonly testHangEvent: Option.Option<string>
  readonly workersEnabled: boolean
  readonly workerMaxConcurrent: number
  readonly workerQueueCapacity: number
  readonly workerDefaultTimeoutMs: Duration.Duration
  readonly workerRetryLimit: number
  readonly workerRequireStructuredResult: boolean
  readonly workerEnforceReadOnlyRoles: boolean
  readonly workerWriteIsolation: WorkerWriteIsolation
  readonly workerIdOverride: Option.Option<string>
  /** US-2: mandatory-worker-delegation gate mode. When ALGORITHM tier ≥ 4
   * and the model attempts a direct Write/Edit/etc. with no active worker,
   * the gate either:
   *  - "off"        : passthrough (default)
   *  - "recommend"  : ask, with a remediation hint
   *  - "strict"     : deny, with a remediation hint
   * Env: CLAUDE_HOOKS_WORKER_MANDATORY_MODE. */
  readonly workerMandatoryMode: WorkerMandatoryMode
}

export type WorkerMandatoryMode = "off" | "recommend" | "strict"

export interface RuntimeConfigApi {
  readonly load: () => Effect.Effect<RuntimeConfig>
}

export class RuntimeConfigService extends Context.Tag("RuntimeConfigService")<
  RuntimeConfigService,
  RuntimeConfigApi
>() {}

export type WorkerWriteIsolation = "none" | "serial" | "worktree"

const millis = (n: number): Duration.Duration => Duration.millis(n)

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  defaultHandlerTimeoutMs: millis(4_000),
  stopTimeoutMs: millis(28_000),
  userPromptSubmitTimeoutMs: millis(30_000),
  classifierTimeoutMs: millis(25_000),
  classifierDisabled: false,
  isaPretoolGateDisabled: false,
  tddGateEnabled: false,
  otelEndpoint: Option.none(),
  lockRetryTimeoutMs: millis(5_000),
  approvalGcInterval: millis(24 * 60 * 60 * 1000),
  testHangEvent: Option.none(),
  workersEnabled: true,
  workerMaxConcurrent: 3,
  workerQueueCapacity: 256,
  workerDefaultTimeoutMs: millis(120_000),
  workerRetryLimit: 1,
  workerRequireStructuredResult: true,
  workerEnforceReadOnlyRoles: true,
  workerWriteIsolation: "serial",
  workerIdOverride: Option.none(),
  workerMandatoryMode: "off",
}

const envWorkerMandatoryMode = (
  value: string | undefined,
  fallback: WorkerMandatoryMode,
): WorkerMandatoryMode => {
  switch (value) {
    case "off":
    case "recommend":
    case "strict":
      return value
    default:
      return fallback
  }
}

const envFlag = (value: string | undefined): boolean =>
  value === "1" || value?.toLowerCase() === "true"

const envFlagOr = (value: string | undefined, fallback: boolean): boolean =>
  value === undefined ? fallback : envFlag(value)

const envPositiveInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const envNonNegativeInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

const envWorkerWriteIsolation = (
  value: string | undefined,
  fallback: WorkerWriteIsolation,
): WorkerWriteIsolation => {
  switch (value) {
    case "none":
    case "serial":
    case "worktree":
      return value
    case "patch":
      return "worktree"
    default:
      return fallback
  }
}

const nonEmpty = (value: string | undefined): Option.Option<string> =>
  typeof value === "string" && value.length > 0
    ? Option.some(value)
    : Option.none()

export const runtimeConfigFromEnv = (
  env: EnvMap,
  base: RuntimeConfig = DEFAULT_RUNTIME_CONFIG,
): RuntimeConfig => ({
  ...base,
  classifierDisabled: envFlag(env["CLAUDE_HOOKS_DISABLE_CLASSIFIER"]),
  isaPretoolGateDisabled: env["CLAUDE_HOOKS_DISABLE_ISA_PRETOOL_GATE"] === "1",
  tddGateEnabled: envFlag(env["CLAUDE_HOOKS_TDD_GATE_ENABLED"]),
  otelEndpoint: Option.map(nonEmpty(env["OTEL_EXPORTER_OTLP_ENDPOINT"]), (v) =>
    Redacted.make(v),
  ),
  testHangEvent: nonEmpty(env["CLAUDE_HOOKS_TEST_HANG_EVENT"]),
  workersEnabled: envFlagOr(env["CLAUDE_HOOKS_WORKERS_ENABLED"], base.workersEnabled),
  workerMaxConcurrent: envPositiveInt(
    env["CLAUDE_HOOKS_WORKER_MAX_CONCURRENT"],
    base.workerMaxConcurrent,
  ),
  workerQueueCapacity: envPositiveInt(
    env["CLAUDE_HOOKS_WORKER_QUEUE_CAPACITY"],
    base.workerQueueCapacity,
  ),
  workerDefaultTimeoutMs: millis(
    envPositiveInt(
      env["CLAUDE_HOOKS_WORKER_DEFAULT_TIMEOUT_MS"],
      durationMillis(base.workerDefaultTimeoutMs),
    ),
  ),
  workerRetryLimit: envNonNegativeInt(
    env["CLAUDE_HOOKS_WORKER_RETRY_LIMIT"],
    base.workerRetryLimit,
  ),
  workerRequireStructuredResult: envFlagOr(
    env["CLAUDE_HOOKS_WORKER_REQUIRE_STRUCTURED_RESULT"],
    base.workerRequireStructuredResult,
  ),
  workerEnforceReadOnlyRoles: envFlagOr(
    env["CLAUDE_HOOKS_WORKER_ENFORCE_READ_ONLY_ROLES"],
    base.workerEnforceReadOnlyRoles,
  ),
  workerWriteIsolation: envWorkerWriteIsolation(
    env["CLAUDE_HOOKS_WORKER_WRITE_ISOLATION"],
    base.workerWriteIsolation,
  ),
  workerIdOverride: nonEmpty(env["CLAUDE_HOOKS_WORKER_ID"]),
  workerMandatoryMode: envWorkerMandatoryMode(
    env["CLAUDE_HOOKS_WORKER_MANDATORY_MODE"],
    base.workerMandatoryMode,
  ),
})

export const loadRuntimeConfig: Effect.Effect<RuntimeConfig> = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(RuntimeConfigService)
  if (Option.isSome(service)) return yield* service.value.load()
  return runtimeConfigFromEnv(currentProcessEnv())
})

export const durationMillis = (duration: Duration.Duration): number =>
  Duration.toMillis(duration)

export interface RuntimeConfigSummary {
  readonly defaultHandlerTimeoutMs: number
  readonly stopTimeoutMs: number
  readonly userPromptSubmitTimeoutMs: number
  readonly classifierTimeoutMs: number
  readonly classifierDisabled: boolean
  readonly isaPretoolGateDisabled: boolean
  readonly tddGateEnabled: boolean
  readonly otelEndpointConfigured: boolean
  readonly lockRetryTimeoutMs: number
  readonly approvalGcIntervalMs: number
  readonly testHangEvent: string | null
  readonly workersEnabled: boolean
  readonly workerMaxConcurrent: number
  readonly workerQueueCapacity: number
  readonly workerDefaultTimeoutMs: number
  readonly workerRetryLimit: number
  readonly workerRequireStructuredResult: boolean
  readonly workerEnforceReadOnlyRoles: boolean
  readonly workerWriteIsolation: WorkerWriteIsolation
  readonly workerMandatoryMode: WorkerMandatoryMode
}

export const summarizeRuntimeConfig = (
  cfg: RuntimeConfig,
): RuntimeConfigSummary => ({
  defaultHandlerTimeoutMs: durationMillis(cfg.defaultHandlerTimeoutMs),
  stopTimeoutMs: durationMillis(cfg.stopTimeoutMs),
  userPromptSubmitTimeoutMs: durationMillis(cfg.userPromptSubmitTimeoutMs),
  classifierTimeoutMs: durationMillis(cfg.classifierTimeoutMs),
  classifierDisabled: cfg.classifierDisabled,
  isaPretoolGateDisabled: cfg.isaPretoolGateDisabled,
  tddGateEnabled: cfg.tddGateEnabled,
  otelEndpointConfigured: Option.isSome(cfg.otelEndpoint),
  lockRetryTimeoutMs: durationMillis(cfg.lockRetryTimeoutMs),
  approvalGcIntervalMs: durationMillis(cfg.approvalGcInterval),
  testHangEvent: Option.getOrNull(cfg.testHangEvent),
  workersEnabled: cfg.workersEnabled,
  workerMaxConcurrent: cfg.workerMaxConcurrent,
  workerQueueCapacity: cfg.workerQueueCapacity,
  workerDefaultTimeoutMs: durationMillis(cfg.workerDefaultTimeoutMs),
  workerRetryLimit: cfg.workerRetryLimit,
  workerRequireStructuredResult: cfg.workerRequireStructuredResult,
  workerEnforceReadOnlyRoles: cfg.workerEnforceReadOnlyRoles,
  workerWriteIsolation: cfg.workerWriteIsolation,
  workerMandatoryMode: cfg.workerMandatoryMode,
})

const makeLive = Effect.sync(() => {
  const cfg = runtimeConfigFromEnv(currentProcessEnv())
  return RuntimeConfigService.of({ load: () => Effect.succeed(cfg) })
})

export const RuntimeConfigLive: Layer.Layer<RuntimeConfigService> =
  Layer.effect(RuntimeConfigService, makeLive)

export const RuntimeConfigTest = (
  override: Partial<RuntimeConfig> = {},
): Layer.Layer<RuntimeConfigService> =>
  Layer.succeed(
    RuntimeConfigService,
    RuntimeConfigService.of({
      load: () => Effect.succeed({ ...DEFAULT_RUNTIME_CONFIG, ...override }),
    }),
  )
