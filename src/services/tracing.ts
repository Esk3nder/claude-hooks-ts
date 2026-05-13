import { Effect, Layer, Option, Redacted } from "effect"
import { loadRuntimeConfig } from "./runtime-config.ts"

const buildOtelLayer = (endpoint: string): Effect.Effect<Layer.Layer<never>> =>
  Effect.gen(function* () {
    const { NodeSdk } = yield* Effect.promise(() => import("@effect/opentelemetry"))
    const { BatchSpanProcessor } = yield* Effect.promise(
      () => import("@opentelemetry/sdk-trace-base"),
    )
    const { OTLPTraceExporter } = yield* Effect.promise(
      () => import("@opentelemetry/exporter-trace-otlp-http"),
    )
    return NodeSdk.layer(() => ({
      resource: { serviceName: "claude-hooks-ts" },
      spanProcessor: new BatchSpanProcessor(
        new OTLPTraceExporter({ url: endpoint }),
      ),
    })) as unknown as Layer.Layer<never>
  })

const buildOtelLayerSafe = (endpoint: string): Effect.Effect<Layer.Layer<never>> =>
  buildOtelLayer(endpoint).pipe(
    Effect.catchAll((err) =>
      Effect.logWarning("tracing_failed_to_load_otel_deps", {
        cause: String(err),
      }).pipe(Effect.as(Layer.empty as Layer.Layer<never>)),
    ),
  )

export const TracingLive: Layer.Layer<never> = Layer.unwrapEffect(
  Effect.gen(function* () {
    const config = yield* loadRuntimeConfig
    if (Option.isNone(config.otelEndpoint)) return Layer.empty as Layer.Layer<never>
    return yield* buildOtelLayerSafe(Redacted.value(config.otelEndpoint.value))
  }),
)

export const tracingLayerWith = (processor: unknown): Layer.Layer<never> =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const { NodeSdk } = yield* Effect.promise(() => import("@effect/opentelemetry"))
      return NodeSdk.layer(() => ({
        resource: { serviceName: "claude-hooks-ts" },
        spanProcessor: processor as never,
      })) as unknown as Layer.Layer<never>
    }),
  )
