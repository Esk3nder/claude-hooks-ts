import { Layer } from "effect"
import { NodeSdk } from "@effect/opentelemetry"
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"

const buildSpanProcessor = (): SpanProcessor => {
  const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
  if (endpoint && endpoint.length > 0) {
    return new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint }))
  }
  return new BatchSpanProcessor(new InMemorySpanExporter())
}

export const TracingLive: Layer.Layer<never> = NodeSdk.layer(() => ({
  resource: { serviceName: "claude-hooks-ts" },
  spanProcessor: buildSpanProcessor(),
})) as unknown as Layer.Layer<never>

export const tracingLayerWith = (
  processor: SpanProcessor,
): Layer.Layer<never> =>
  NodeSdk.layer(() => ({
    resource: { serviceName: "claude-hooks-ts" },
    spanProcessor: processor,
  })) as unknown as Layer.Layer<never>
