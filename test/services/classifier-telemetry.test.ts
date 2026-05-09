import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ClassifierTelemetry,
  ClassifierTelemetryLive,
  ClassifierTelemetryTest,
  buildPromptExcerpt,
  buildRecord,
} from "../../src/services/classifier-telemetry.ts"

describe("buildPromptExcerpt", () => {
  test("matches PAI prompt.slice(0, 120)", () => {
    expect(buildPromptExcerpt("hello")).toBe("hello")
    expect(buildPromptExcerpt("x".repeat(200)).length).toBe(120)
  })
})

describe("buildRecord", () => {
  test("produces PAI-shaped record", () => {
    const r = buildRecord({
      sessionId: "sid",
      prompt: "implement OAuth refresh flow",
      mode: "ALGORITHM",
      tier: 3,
      modeReason: "multi-file work",
      source: "classifier",
      latencyMs: 4321,
    })
    expect(r.session_id).toBe("sid")
    expect(r.prompt_excerpt).toBe("implement OAuth refresh flow")
    expect(r.mode).toBe("ALGORITHM")
    expect(r.tier).toBe(3)
    expect(r.mode_reason).toBe("multi-file work")
    expect(r.source).toBe("classifier")
    expect(r.latency_ms).toBe(4321)
    // ISO 8601 timestamp
    expect(r.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
})

describe("ClassifierTelemetryLive — JSONL append", () => {
  test("appends a single JSON line under .claude-hooks/state/observability/", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-tel-"))
    try {
      const program = Effect.gen(function* () {
        const t = yield* ClassifierTelemetry
        yield* t.append(
          buildRecord({
            sessionId: "s1",
            prompt: "hello",
            mode: "MINIMAL",
            tier: null,
            modeReason: "ack",
            source: "classifier",
            latencyMs: 0,
          }),
        )
      })
      await Effect.runPromise(
        program.pipe(Effect.provide(ClassifierTelemetryLive(root))),
      )
      const file = join(root, ".claude-hooks", "state", "observability", "mode-classifier.jsonl")
      expect(existsSync(file)).toBe(true)
      const content = readFileSync(file, "utf8").trim()
      const parsed = JSON.parse(content) as { mode: string; session_id: string }
      expect(parsed.mode).toBe("MINIMAL")
      expect(parsed.session_id).toBe("s1")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("multiple appends each become a separate JSON line", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-tel-"))
    try {
      const program = Effect.gen(function* () {
        const t = yield* ClassifierTelemetry
        for (let i = 0; i < 3; i++) {
          yield* t.append(
            buildRecord({
              sessionId: `s${i}`,
              prompt: `p${i}`,
              mode: "ALGORITHM",
              tier: 3,
              modeReason: "x",
              source: "classifier",
              latencyMs: 0,
            }),
          )
        }
      })
      await Effect.runPromise(
        program.pipe(Effect.provide(ClassifierTelemetryLive(root))),
      )
      const file = join(root, ".claude-hooks", "state", "observability", "mode-classifier.jsonl")
      const lines = readFileSync(file, "utf8").trim().split("\n")
      expect(lines.length).toBe(3)
      for (const line of lines) {
        const parsed = JSON.parse(line) as { mode: string }
        expect(parsed.mode).toBe("ALGORITHM")
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("write failure is swallowed (best-effort, never blocks)", async () => {
    // Provide an unwritable root path; append must not throw.
    const program = Effect.gen(function* () {
      const t = yield* ClassifierTelemetry
      yield* t.append(
        buildRecord({
          sessionId: "s",
          prompt: "p",
          mode: "MINIMAL",
          tier: null,
          modeReason: "x",
          source: "classifier",
          latencyMs: 0,
        }),
      )
    })
    // /dev/null/foo is unwritable on macOS/Linux as a directory.
    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(ClassifierTelemetryLive("/dev/null/foo"))),
      ),
    ).resolves.toBeUndefined()
  })
})

describe("ClassifierTelemetryTest — in-memory capture for assertions", () => {
  test("captured records readable via getter", async () => {
    const { layer, records } = ClassifierTelemetryTest()
    const program = Effect.gen(function* () {
      const t = yield* ClassifierTelemetry
      yield* t.append(
        buildRecord({
          sessionId: "s",
          prompt: "p",
          mode: "NATIVE",
          tier: null,
          modeReason: "x",
          source: "classifier",
          latencyMs: 100,
        }),
      )
    })
    await Effect.runPromise(program.pipe(Effect.provide(layer)))
    const captured = records()
    expect(captured.length).toBe(1)
    expect(captured[0]?.mode).toBe("NATIVE")
    expect(captured[0]?.latency_ms).toBe(100)
  })
})
