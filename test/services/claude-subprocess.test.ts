import { describe, expect, test } from "bun:test"
import { scrubClaudeEnv } from "../../src/services/claude-subprocess.ts"

describe("scrubClaudeEnv (B2 — silent-billing prevention)", () => {
  // US-23 (2026-05-20): contract changed from "drop scrubbed keys"
  // to "mask scrubbed keys with empty string". Reason: Effect's
  // `Command.env` is additive and the BunCommandExecutor merges our
  // env with the parent's process.env at spawn time, so dropping
  // a key would let the parent's value leak through. Masking with
  // "" overrides the parent's value. The security-critical claim
  // ("API key not forwarded to subprocess") is satisfied either
  // way — the difference is the child sees `KEY=""` vs no KEY.
  test("masks ANTHROPIC_API_KEY with empty string", () => {
    const out = scrubClaudeEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-...",
    })
    expect(out["ANTHROPIC_API_KEY"]).toBe("")
    expect(out["PATH"]).toBe("/usr/bin")
  })

  test("masks ANTHROPIC_AUTH_TOKEN with empty string", () => {
    const out = scrubClaudeEnv({
      PATH: "/usr/bin",
      ANTHROPIC_AUTH_TOKEN: "tok-...",
    })
    expect(out["ANTHROPIC_AUTH_TOKEN"]).toBe("")
  })

  test("masks CLAUDECODE with empty string so nested-session guard does not reject", () => {
    const out = scrubClaudeEnv({
      PATH: "/usr/bin",
      CLAUDECODE: "1",
    })
    expect(out["CLAUDECODE"]).toBe("")
  })

  test("masks all three at once and preserves everything else", () => {
    const out = scrubClaudeEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      ANTHROPIC_API_KEY: "sk-ant-x",
      ANTHROPIC_AUTH_TOKEN: "tok-x",
      CLAUDECODE: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-keep-me",
      LANG: "en_US.UTF-8",
    })
    expect(out["ANTHROPIC_API_KEY"]).toBe("")
    expect(out["ANTHROPIC_AUTH_TOKEN"]).toBe("")
    expect(out["CLAUDECODE"]).toBe("")
    expect(out["PATH"]).toBe("/usr/bin")
    expect(out["HOME"]).toBe("/home/x")
    expect(out["LANG"]).toBe("en_US.UTF-8")
    // OAuth token MUST survive — that's the credential we want billing to use.
    expect(out["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("oauth-keep-me")
  })

  test("masks scrub targets even if absent from source (US-23 boundary)", () => {
    // The actual threat vector: parent has CLAUDECODE=1, source env
    // doesn't mention it. Pre-US-23 scrubClaudeEnv would output a
    // record without CLAUDECODE — and the executor's parent-env
    // merge would re-introduce it. Post-fix, masking happens
    // unconditionally so the explicit "" overrides parent's value.
    const out = scrubClaudeEnv({ PATH: "/usr/bin" })
    expect(out["ANTHROPIC_API_KEY"]).toBe("")
    expect(out["ANTHROPIC_AUTH_TOKEN"]).toBe("")
    expect(out["CLAUDECODE"]).toBe("")
    expect(out["PATH"]).toBe("/usr/bin")
  })

  test("ignores non-string env values defensively", () => {
    const dirty = {
      PATH: "/usr/bin",
      WEIRD: undefined,
    } as unknown as NodeJS.ProcessEnv
    const out = scrubClaudeEnv(dirty)
    expect(out["PATH"]).toBe("/usr/bin")
    expect("WEIRD" in out).toBe(false)
  })

  test("does not mutate the source env", () => {
    const src: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-x",
    }
    scrubClaudeEnv(src)
    expect(src["ANTHROPIC_API_KEY"]).toBe("sk-ant-x")
  })
})

/**
 * B4 + B5 are integration concerns that exercise live subprocess behavior
 * (listener cleanup after timeout; SIGKILL fallback after SIGTERM is
 * ignored). Asserting these without spawning a real process requires a
 * test double for child_process.spawn — out of scope for this slice. The
 * implementation has explicit comments at the call sites and the patterns
 * are the same that this package's Inference.ts has been running in production.
 */
