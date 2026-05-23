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
      CLAUDE_HOOKS_CONTEXT_BUDGET_THRESHOLD_PCT: "72",
      CLAUDE_HOOKS_READ_TLDR_ENABLED: "1",
      CLAUDE_HOOKS_READ_TLDR_MIN_LINES: "123",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example/v1/traces",
      CLAUDE_HOOKS_TEST_HANG_EVENT: "Stop",
      CLAUDE_HOOKS_WORKERS_ENABLED: "false",
      CLAUDE_HOOKS_WORKER_MAX_CONCURRENT: "5",
      CLAUDE_HOOKS_WORKER_QUEUE_CAPACITY: "512",
      CLAUDE_HOOKS_WORKER_DEFAULT_TIMEOUT_MS: "90000",
      CLAUDE_HOOKS_WORKER_RETRY_LIMIT: "2",
      CLAUDE_HOOKS_WORKER_REQUIRE_STRUCTURED_RESULT: "false",
      CLAUDE_HOOKS_WORKER_ENFORCE_READ_ONLY_ROLES: "false",
      CLAUDE_HOOKS_WORKER_WRITE_ISOLATION: "worktree",
    })

    expect(cfg.classifierDisabled).toBe(true)
    expect(cfg.isaPretoolGateDisabled).toBe(true)
    expect(cfg.contextBudgetThresholdPct).toBe(72)
    expect(cfg.readTldrEnabled).toBe(true)
    expect(cfg.readTldrMinLines).toBe(123)
    expect(Option.isSome(cfg.otelEndpoint)).toBe(true)
    expect(Option.getOrNull(cfg.testHangEvent)).toBe("Stop")
    expect(cfg.workersEnabled).toBe(false)
    expect(cfg.workerMaxConcurrent).toBe(5)
    expect(cfg.workerQueueCapacity).toBe(512)
    expect(Duration.toMillis(cfg.workerDefaultTimeoutMs)).toBe(90_000)
    expect(cfg.workerRetryLimit).toBe(2)
    expect(cfg.workerRequireStructuredResult).toBe(false)
    expect(cfg.workerEnforceReadOnlyRoles).toBe(false)
    expect(cfg.workerWriteIsolation).toBe("worktree")
    expect(summarizeRuntimeConfig(cfg)).toMatchObject({
      classifierDisabled: true,
      isaPretoolGateDisabled: true,
      contextBudgetThresholdPct: 72,
      readTldrEnabled: true,
      readTldrMinLines: 123,
      otelEndpointConfigured: true,
      testHangEvent: "Stop",
      workersEnabled: false,
      workerMaxConcurrent: 5,
      workerQueueCapacity: 512,
      workerDefaultTimeoutMs: 90_000,
      workerRetryLimit: 2,
      workerRequireStructuredResult: false,
      workerEnforceReadOnlyRoles: false,
      workerWriteIsolation: "worktree",
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
