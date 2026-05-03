import { Effect, Layer } from "effect"

const enabled = (): boolean => {
  const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
  return endpoint !== undefined && endpoint.length > 0
}

const buildOtelLayer = Effect.gen(function* () {
  const { NodeSdk } = yield* Effect.promise(() => import("@effect/opentelemetry"))
  const { BatchSpanProcessor } = yield* Effect.promise(
    () => import("@opentelemetry/sdk-trace-base"),
  )
  const { OTLPTraceExporter } = yield* Effect.promise(
    () => import("@opentelemetry/exporter-trace-otlp-http"),
  )
  const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]!
  return NodeSdk.layer(() => ({
    resource: { serviceName: "claude-hooks-ts" },
    spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint })),
  })) as unknown as Layer.Layer<never>
})

export const TracingLive: Layer.Layer<never> = enabled()
  ? Layer.unwrapEffect(buildOtelLayer)
  : Layer.empty

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
