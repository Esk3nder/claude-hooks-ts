import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import {
  ClaudeSubprocess,
  ClaudeSubprocessTest,
  type ClaudeSpawnOptions,
} from "../../src/services/claude-subprocess.ts"

describe("ClaudeSubprocess Effect service plumbing", () => {
  test("test layer responder receives args + opts and round-trips a result", async () => {
    const captured: {
      args: ReadonlyArray<string> | null
      opts: ClaudeSpawnOptions | null
    } = { args: null, opts: null }
    const layer = ClaudeSubprocessTest((args, opts) => {
      captured.args = args
      captured.opts = opts
      return {
        stdout: "MODE: ALGORITHM | TIER: E3 | REASON: ok | SOURCE: classifier",
        stderr: "",
        exitCode: 0,
        latencyMs: 42,
        timedOut: false,
      }
    })

    const program = Effect.gen(function* () {
      const svc = yield* ClaudeSubprocess
      return yield* svc.spawn(["--print", "--model", "haiku"], {
        stdin: "hi",
        timeoutMs: 15_000,
      })
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("MODE: ALGORITHM")
    expect(result.latencyMs).toBe(42)
    expect(result.timedOut).toBe(false)
    expect(captured.args).toEqual(["--print", "--model", "haiku"])
    expect(captured.opts?.stdin).toBe("hi")
    expect(captured.opts?.timeoutMs).toBe(15_000)
  })

  test("test layer can simulate timeout (timedOut: true) without hanging", async () => {
    const layer = ClaudeSubprocessTest(() => ({
      stdout: "",
      stderr: "",
      exitCode: -1,
      latencyMs: 25_000,
      timedOut: true,
    }))
    const program = Effect.gen(function* () {
      const svc = yield* ClaudeSubprocess
      return yield* svc.spawn([], { stdin: "", timeoutMs: 25_000 })
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBe(-1)
  })

  test("default test layer (no responder) returns a clean zero result", async () => {
    const layer: Layer.Layer<ClaudeSubprocess> = ClaudeSubprocessTest()
    const program = Effect.gen(function* () {
      const svc = yield* ClaudeSubprocess
      return yield* svc.spawn(["--print"], { stdin: "x", timeoutMs: 1000 })
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.timedOut).toBe(false)
  })
})
