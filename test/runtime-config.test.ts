import { describe, expect, test } from "bun:test"
import { Duration, Effect, Option } from "effect"
import { classify } from "../src/algorithm/classifier.ts"
import { handlerTimeoutFor } from "../src/dispatcher.ts"
import { InferenceTest } from "../src/services/inference.ts"
import { ClaudeSubprocessTest } from "../src/services/claude-subprocess.ts"
import {
  runtimeConfigFromEnv,
  summarizeRuntimeConfig,
  RuntimeConfigTest,
  DEFAULT_RUNTIME_CONFIG,
} from "../src/services/runtime-config.ts"

describe("RuntimeConfigService", () => {
  test("decodes env into typed non-secret runtime config summary", () => {
    const cfg = runtimeConfigFromEnv({
      CLAUDE_HOOKS_DISABLE_CLASSIFIER: "true",
      CLAUDE_HOOKS_DISABLE_ISA_PRETOOL_GATE: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example/v1/traces",
      CLAUDE_HOOKS_TEST_HANG_EVENT: "Stop",
    })

    expect(cfg.classifierDisabled).toBe(true)
    expect(cfg.isaPretoolGateDisabled).toBe(true)
    expect(Option.isSome(cfg.otelEndpoint)).toBe(true)
    expect(Option.getOrNull(cfg.testHangEvent)).toBe("Stop")
    expect(summarizeRuntimeConfig(cfg)).toMatchObject({
      classifierDisabled: true,
      isaPretoolGateDisabled: true,
      otelEndpointConfigured: true,
      testHangEvent: "Stop",
    })
  })

  test("handler timeout table comes from typed config", () => {
    const cfg = {
      ...DEFAULT_RUNTIME_CONFIG,
      defaultHandlerTimeoutMs: Duration.millis(111),
      stopTimeoutMs: Duration.millis(222),
      userPromptSubmitTimeoutMs: Duration.millis(333),
    }

    expect(handlerTimeoutFor("PreToolUse", cfg)).toBe(111)
    expect(handlerTimeoutFor("Stop", cfg)).toBe(222)
    expect(handlerTimeoutFor("UserPromptSubmit", cfg)).toBe(333)
  })

  test("tests override config by swapping a layer", async () => {
    let inferenceCalls = 0
    const result = await Effect.runPromise(
      classify("build a multi-file feature").pipe(
        Effect.provide(
          InferenceTest(() => {
            inferenceCalls++
            return {
              mode: "ALGORITHM",
              tier: 5,
              reason: "should not be called",
              source: "classifier",
              latencyMs: 1,
            }
          }),
        ),
        Effect.provide(ClaudeSubprocessTest()),
        Effect.provide(RuntimeConfigTest({ classifierDisabled: true })),
      ),
    )

    expect(result.source).toBe("fail-safe")
    expect(result.tier).toBe(3)
    expect(inferenceCalls).toBe(0)
  })
})
