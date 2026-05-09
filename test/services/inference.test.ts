import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  Inference,
  InferenceLive,
  parseClassifierResponse,
  CLASSIFIER_SYSTEM_PROMPT,
  type Classification,
} from "../../src/services/inference.ts"
import {
  ClaudeSubprocess,
  ClaudeSubprocessTest,
  type ClaudeSpawnResult,
} from "../../src/services/claude-subprocess.ts"

const provideSubprocess = (result: ClaudeSpawnResult) =>
  ClaudeSubprocessTest(() => result)

const runClassify = async (
  result: ClaudeSpawnResult,
  prompt = "implement OAuth refresh flow",
): Promise<Classification> => {
  const program = Effect.gen(function* () {
    const inf = yield* Inference
    return yield* inf.classify(prompt)
  })
  return Effect.runPromise(
    program.pipe(
      Effect.provide(InferenceLive),
      Effect.provide(provideSubprocess(result)),
    ),
  )
}

describe("parseClassifierResponse (the upstream spec JSON protocol)", () => {
  test("parses canonical ALGORITHM JSON", () => {
    const r = parseClassifierResponse(
      `{"mode":"ALGORITHM","tier":3,"mode_reason":"multi-file refactor"}`,
    )
    expect(r._tag).toBe("ok")
    if (r._tag === "ok") {
      expect(r.mode).toBe("ALGORITHM")
      expect(r.tier).toBe(3)
      expect(r.reason).toBe("multi-file refactor")
    }
  })

  test("parses MINIMAL with tier null", () => {
    const r = parseClassifierResponse(
      `{"mode":"MINIMAL","tier":null,"mode_reason":"acknowledgment"}`,
    )
    expect(r._tag).toBe("ok")
    if (r._tag === "ok") {
      expect(r.mode).toBe("MINIMAL")
      expect(r.tier).toBe(null)
    }
  })

  test("parses NATIVE with tier null", () => {
    const r = parseClassifierResponse(
      `{"mode":"NATIVE","tier":null,"mode_reason":"single fact lookup"}`,
    )
    expect(r._tag).toBe("ok")
    if (r._tag === "ok") {
      expect(r.mode).toBe("NATIVE")
      expect(r.tier).toBe(null)
    }
  })

  test("strips ```json fences (defensive — Sonnet sometimes wraps)", () => {
    const r = parseClassifierResponse(
      "```json\n{\"mode\":\"ALGORITHM\",\"tier\":4,\"mode_reason\":\"x\"}\n```",
    )
    expect(r._tag).toBe("ok")
    if (r._tag === "ok") expect(r.tier).toBe(4)
  })

  test("extracts JSON object even with surrounding prose", () => {
    const r = parseClassifierResponse(
      "Here is the classification: {\"mode\":\"NATIVE\",\"tier\":null,\"mode_reason\":\"x\"} — done",
    )
    expect(r._tag).toBe("ok")
  })

  test("rejects empty response", () => {
    expect(parseClassifierResponse("")._tag).toBe("fail")
  })

  test("rejects missing mode", () => {
    const r = parseClassifierResponse(`{"tier":3,"mode_reason":"x"}`)
    expect(r._tag).toBe("fail")
  })

  test("rejects ALGORITHM without tier", () => {
    const r = parseClassifierResponse(
      `{"mode":"ALGORITHM","tier":null,"mode_reason":"x"}`,
    )
    expect(r._tag).toBe("fail")
  })

  test("rejects unknown mode value", () => {
    const r = parseClassifierResponse(
      `{"mode":"SUPER","tier":3,"mode_reason":"x"}`,
    )
    expect(r._tag).toBe("fail")
  })

  test("rejects out-of-range tier", () => {
    const r = parseClassifierResponse(
      `{"mode":"ALGORITHM","tier":7,"mode_reason":"x"}`,
    )
    expect(r._tag).toBe("fail")
  })

  test("rejects non-JSON garbage", () => {
    const r = parseClassifierResponse("nope, just prose")
    expect(r._tag).toBe("fail")
  })

  test("B6 fix: whitespace-only mode_reason becomes '(no reason given)'", () => {
    const r = parseClassifierResponse(
      `{"mode":"NATIVE","tier":null,"mode_reason":"   "}`,
    )
    expect(r._tag).toBe("ok")
    if (r._tag === "ok") expect(r.reason).toBe("(no reason given)")
  })

  test("B6 fix: tab/newline-only mode_reason also becomes '(no reason given)'", () => {
    const r = parseClassifierResponse(
      `{"mode":"NATIVE","tier":null,"mode_reason":"\\t\\n"}`,
    )
    expect(r._tag).toBe("ok")
    if (r._tag === "ok") expect(r.reason).toBe("(no reason given)")
  })

  test("B6 fix: mode_reason gets trimmed of surrounding whitespace", () => {
    const r = parseClassifierResponse(
      `{"mode":"NATIVE","tier":null,"mode_reason":"  real reason  "}`,
    )
    expect(r._tag).toBe("ok")
    if (r._tag === "ok") expect(r.reason).toBe("real reason")
  })
})

describe("Inference.classify (with ClaudeSubprocessTest layer)", () => {
  test("happy path → parsed classifier result", async () => {
    const c = await runClassify({
      stdout: `{"mode":"ALGORITHM","tier":3,"mode_reason":"multi-file refactor"}`,
      stderr: "",
      exitCode: 0,
      latencyMs: 4321,
      timedOut: false,
    })
    expect(c.mode).toBe("ALGORITHM")
    expect(c.tier).toBe(3)
    expect(c.source).toBe("classifier")
    expect(c.latencyMs).toBe(4321)
  })

  test("timed-out subprocess → fail-safe tier 3", async () => {
    const c = await runClassify({
      stdout: "",
      stderr: "",
      exitCode: -1,
      latencyMs: 14_000,
      timedOut: true,
    })
    expect(c.mode).toBe("ALGORITHM")
    expect(c.tier).toBe(3)
    expect(c.source).toBe("fail-safe")
    expect(c.reason).toContain("timeout")
  })

  test("non-zero exit → fail-safe tier 3 with stderr in reason", async () => {
    const c = await runClassify({
      stdout: "",
      stderr: "claude: not authenticated",
      exitCode: 2,
      latencyMs: 100,
      timedOut: false,
    })
    expect(c.mode).toBe("ALGORITHM")
    expect(c.tier).toBe(3)
    expect(c.source).toBe("fail-safe")
    expect(c.reason).toContain("exit 2")
  })

  test("unparseable stdout → fail-safe tier 3", async () => {
    const c = await runClassify({
      stdout: "lol I am a chatbot",
      stderr: "",
      exitCode: 0,
      latencyMs: 200,
      timedOut: false,
    })
    expect(c.source).toBe("fail-safe")
    expect(c.reason).toContain("parse-fail")
  })

  test("MINIMAL response keeps tier null", async () => {
    const c = await runClassify({
      stdout: `{"mode":"MINIMAL","tier":null,"mode_reason":"greeting"}`,
      stderr: "",
      exitCode: 0,
      latencyMs: 50,
      timedOut: false,
    })
    expect(c.mode).toBe("MINIMAL")
    expect(c.tier).toBe(null)
  })

  test("subprocess called with sonnet + cache flag + verbatim the rubric", async () => {
    let capturedArgs: ReadonlyArray<string> = []
    let capturedStdin = ""
    const layer = ClaudeSubprocessTest((args, opts) => {
      capturedArgs = args
      capturedStdin = opts.stdin
      return {
        stdout: `{"mode":"NATIVE","tier":null,"mode_reason":"x"}`,
        stderr: "",
        exitCode: 0,
        latencyMs: 1,
        timedOut: false,
      }
    })
    const program = Effect.gen(function* () {
      const inf = yield* Inference
      return yield* inf.classify("read README.md")
    })
    await Effect.runPromise(
      program.pipe(Effect.provide(InferenceLive), Effect.provide(layer)),
    )
    expect(capturedArgs).toContain("--print")
    // the spec uses Sonnet for the classifier (Algorithm v6.3.0 line 73).
    expect(capturedArgs).toContain("sonnet")
    // the upstream cache-friendly flag.
    expect(capturedArgs).toContain("--exclude-dynamic-system-prompt-sections")
    const sysIdx = capturedArgs.indexOf("--system-prompt")
    expect(sysIdx).toBeGreaterThan(-1)
    // Byte-for-byte rubric pin.
    expect(capturedArgs[sysIdx + 1]).toBe(CLASSIFIER_SYSTEM_PROMPT)
    expect(capturedStdin).toBe("read README.md")
  })
})

describe("CLASSIFIER_SYSTEM_PROMPT — Algorithm doctrine pin", () => {
  test("contains TASK 3 of the classifier doctrine header verbatim", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("## TASK 3: MODE + TIER CLASSIFICATION")
  })
  test("contains the single-word-approval doctrine rule", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain(
      "Single-word approvals to multi-step plans are NEVER MINIMAL",
    )
  })
  test("contains the casual-phrasing rule", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain(
      "Casual phrasing (\"build me a quick X\") does NOT downgrade",
    )
  })
  test("contains all 6 worked examples", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('"thanks" with no context')
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('"yes" after assistant proposed three numbered fixes')
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('"what time is it"')
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('"fix the typo on line 12 of foo.ts"')
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('"build me a complex application"')
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('"audit the algorithm and update doctrine"')
  })
  test("contains the full NATIVE artifact enumeration", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain(
      "no new file, function, feature, route, table, hook, skill, agent, integration, page",
    )
  })
  test("contains the full ALGORITHM trigger enumeration", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain(
      "build/create/make/implement/design/develop/scaffold/prototype/architect/refactor/migrate/integrate",
    )
  })
  test("specifies JSON output format", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("OUTPUT FORMAT (JSON only")
  })
})
