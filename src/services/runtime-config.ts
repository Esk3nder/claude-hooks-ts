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
  readonly otelEndpoint: Option.Option<Redacted.Redacted<string>>
  readonly lockRetryTimeoutMs: Duration.Duration
  readonly approvalGcInterval: Duration.Duration
  readonly testHangEvent: Option.Option<string>
}

export interface RuntimeConfigApi {
  readonly load: () => Effect.Effect<RuntimeConfig>
}

export class RuntimeConfigService extends Context.Tag("RuntimeConfigService")<
  RuntimeConfigService,
  RuntimeConfigApi
>() {}

const millis = (n: number): Duration.Duration => Duration.millis(n)

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  defaultHandlerTimeoutMs: millis(4_000),
  stopTimeoutMs: millis(28_000),
  userPromptSubmitTimeoutMs: millis(30_000),
  classifierTimeoutMs: millis(25_000),
  classifierDisabled: false,
  isaPretoolGateDisabled: false,
  otelEndpoint: Option.none(),
  lockRetryTimeoutMs: millis(5_000),
  approvalGcInterval: millis(24 * 60 * 60 * 1000),
  testHangEvent: Option.none(),
}

const envFlag = (value: string | undefined): boolean =>
  value === "1" || value?.toLowerCase() === "true"

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
  otelEndpoint: Option.map(nonEmpty(env["OTEL_EXPORTER_OTLP_ENDPOINT"]), (v) =>
    Redacted.make(v),
  ),
  testHangEvent: nonEmpty(env["CLAUDE_HOOKS_TEST_HANG_EVENT"]),
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
  readonly otelEndpointConfigured: boolean
  readonly lockRetryTimeoutMs: number
  readonly approvalGcIntervalMs: number
  readonly testHangEvent: string | null
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
  otelEndpointConfigured: Option.isSome(cfg.otelEndpoint),
  lockRetryTimeoutMs: durationMillis(cfg.lockRetryTimeoutMs),
  approvalGcIntervalMs: durationMillis(cfg.approvalGcInterval),
  testHangEvent: Option.getOrNull(cfg.testHangEvent),
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
