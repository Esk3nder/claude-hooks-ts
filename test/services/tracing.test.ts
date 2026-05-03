import { describe, expect, test } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { tracingLayerWith } from "../../src/services/tracing.ts"

describe("tracing (Item #6)", () => {
  test("Effect.withSpan emits a span recorded by InMemorySpanExporter", async () => {
    const exporter = new InMemorySpanExporter()
    const processor = new SimpleSpanProcessor(exporter)
    const layer = tracingLayerWith(processor)
    const runtime = ManagedRuntime.make(layer)

    const program = Effect.sync(() => "ok").pipe(
      Effect.withSpan("dispatch", { attributes: { event: "PreToolUse" } }),
    )

    await runtime.runPromise(program)

    const spans = exporter.getFinishedSpans()
    const dispatch = spans.find((s) => s.name === "dispatch")
    expect(dispatch).toBeDefined()
    expect(dispatch?.attributes["event"]).toBe("PreToolUse")

    await runtime.dispose()
  })
})
