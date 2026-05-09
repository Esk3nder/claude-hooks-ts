/**
 * Coverage for the L10/L12/L13/L16 fixes — context plumbing, cleanPrompt,
 * 25s timeout, image-args branch.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  Inference,
  InferenceLive,
  cleanPrompt,
  buildUserPrompt,
} from "../../src/services/inference.ts"
import {
  ClaudeSubprocessTest,
  type ClaudeSpawnOptions,
} from "../../src/services/claude-subprocess.ts"

describe("cleanPrompt — the upstream classifier verbatim", () => {
  test("strips HTML/tag tokens", () => {
    expect(cleanPrompt("<system-reminder>foo</system-reminder>bar")).toBe(
      "foo bar",
    )
  })
  test("normalizes whitespace runs to single space", () => {
    expect(cleanPrompt("a   b\t\tc\n\nd")).toBe("a b c d")
  })
  test("trims leading and trailing whitespace", () => {
    expect(cleanPrompt("   hello world   ")).toBe("hello world")
  })
  test("caps at 1000 chars", () => {
    const long = "x".repeat(2000)
    expect(cleanPrompt(long).length).toBe(1000)
  })
  test("preserves 1000 chars exactly when below cap", () => {
    expect(cleanPrompt("hello").length).toBe(5)
  })
  test("collapses across stripped tags", () => {
    // Stripping <X> leaves a space, then whitespace normalization collapses.
    expect(cleanPrompt("a <b> c <d> e")).toBe("a c e")
  })
})

describe("buildUserPrompt — CONTEXT/CURRENT MESSAGE framing", () => {
  test("without context, returns just cleanPrompt", () => {
    expect(buildUserPrompt("hello world")).toBe("hello world")
  })
  test("with context, prepends CONTEXT: and CURRENT MESSAGE: framing", () => {
    const out = buildUserPrompt("yes", "User: do these three fixes\nAssistant: proposed plan")
    expect(out).toBe(
      "CONTEXT:\nUser: do these three fixes\nAssistant: proposed plan\n\nCURRENT MESSAGE:\nyes",
    )
  })
  test("empty context string is treated as no context", () => {
    expect(buildUserPrompt("hello", "")).toBe("hello")
  })
  test("cleans the prompt before framing", () => {
    expect(buildUserPrompt("  <x>hello</x>  ", "ctx")).toBe(
      "CONTEXT:\nctx\n\nCURRENT MESSAGE:\nhello",
    )
  })
})

describe("Inference.classify — context plumbing (L10)", () => {
  test("context arg threads through to subprocess stdin", async () => {
    let capturedStdin = ""
    const layer = ClaudeSubprocessTest((args, opts: ClaudeSpawnOptions) => {
      void args
      capturedStdin = opts.stdin
      return {
        stdout: `{"mode":"ALGORITHM","tier":3,"mode_reason":"approves prior plan"}`,
        stderr: "",
        exitCode: 0,
        latencyMs: 1,
        timedOut: false,
      }
    })
    const program = Effect.gen(function* () {
      const inf = yield* Inference
      return yield* inf.classify("yes", {
        context: "Assistant: proposed three numbered fixes",
      })
    })
    await Effect.runPromise(
      program.pipe(Effect.provide(InferenceLive), Effect.provide(layer)),
    )
    expect(capturedStdin).toContain("CONTEXT:")
    expect(capturedStdin).toContain("Assistant: proposed three numbered fixes")
    expect(capturedStdin).toContain("CURRENT MESSAGE:")
    expect(capturedStdin).toContain("yes")
  })
})

describe("Inference.classify — cleanPrompt applied (L12)", () => {
  test("HTML in prompt is stripped before reaching subprocess", async () => {
    let capturedStdin = ""
    const layer = ClaudeSubprocessTest((args, opts) => {
      void args
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
      return yield* inf.classify("<script>alert(1)</script>do something")
    })
    await Effect.runPromise(
      program.pipe(Effect.provide(InferenceLive), Effect.provide(layer)),
    )
    expect(capturedStdin).not.toContain("<script>")
    expect(capturedStdin).toContain("do something")
  })
})

describe("Inference default timeout — 25s (L13, the upstream classifier)", () => {
  test("classify uses 25_000 ms by default", async () => {
    let capturedTimeout = 0
    const layer = ClaudeSubprocessTest((args, opts) => {
      void args
      capturedTimeout = opts.timeoutMs
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
      return yield* inf.classify("hello")
    })
    await Effect.runPromise(
      program.pipe(Effect.provide(InferenceLive), Effect.provide(layer)),
    )
    expect(capturedTimeout).toBe(25_000)
  })
  test("override via opts.timeoutMs is honored", async () => {
    let capturedTimeout = 0
    const layer = ClaudeSubprocessTest((args, opts) => {
      void args
      capturedTimeout = opts.timeoutMs
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
      return yield* inf.classify("hello", { timeoutMs: 5000 })
    })
    await Effect.runPromise(
      program.pipe(Effect.provide(InferenceLive), Effect.provide(layer)),
    )
    expect(capturedTimeout).toBe(5000)
  })
})

describe("Inference image-args branch (L16, the upstream classifier)", () => {
  test("no images → '--tools ' '' in args", async () => {
    let capturedArgs: ReadonlyArray<string> = []
    const layer = ClaudeSubprocessTest((args, opts) => {
      capturedArgs = args
      void opts
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
      return yield* inf.classify("hello")
    })
    await Effect.runPromise(
      program.pipe(Effect.provide(InferenceLive), Effect.provide(layer)),
    )
    expect(capturedArgs).toContain("--tools")
    expect(capturedArgs).not.toContain("--allowedTools")
  })

  test("with imagePaths → '--allowedTools Read' replaces '--tools ''", async () => {
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
      return yield* inf.classify("describe these images", {
        imagePaths: ["/tmp/a.png", "/tmp/b.png"],
      })
    })
    await Effect.runPromise(
      program.pipe(Effect.provide(InferenceLive), Effect.provide(layer)),
    )
    expect(capturedArgs).toContain("--allowedTools")
    expect(capturedArgs).toContain("Read")
    // With images, the '--tools' flag is replaced — but '--setting-sources ""'
    // still has an empty string second arg, which is correct.
    expect(capturedArgs).not.toContain("--tools")
    // the upstream classifier: image refs prepended to user prompt as @path lines.
    expect(capturedStdin).toContain("@/tmp/a.png")
    expect(capturedStdin).toContain("@/tmp/b.png")
    expect(capturedStdin).toContain("describe these images")
  })
})
