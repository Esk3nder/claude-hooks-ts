import { describe, expect, test } from "bun:test"
import { scrubClaudeEnv } from "../../src/services/claude-subprocess.ts"

describe("scrubClaudeEnv (B2 — silent-billing prevention)", () => {
  test("removes ANTHROPIC_API_KEY", () => {
    const out = scrubClaudeEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-...",
    })
    expect("ANTHROPIC_API_KEY" in out).toBe(false)
    expect(out["PATH"]).toBe("/usr/bin")
  })

  test("removes ANTHROPIC_AUTH_TOKEN", () => {
    const out = scrubClaudeEnv({
      PATH: "/usr/bin",
      ANTHROPIC_AUTH_TOKEN: "tok-...",
    })
    expect("ANTHROPIC_AUTH_TOKEN" in out).toBe(false)
  })

  test("removes CLAUDECODE so nested-session guard does not reject", () => {
    const out = scrubClaudeEnv({
      PATH: "/usr/bin",
      CLAUDECODE: "1",
    })
    expect("CLAUDECODE" in out).toBe(false)
  })

  test("removes all three at once and preserves everything else", () => {
    const out = scrubClaudeEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      ANTHROPIC_API_KEY: "sk-ant-x",
      ANTHROPIC_AUTH_TOKEN: "tok-x",
      CLAUDECODE: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-keep-me",
      LANG: "en_US.UTF-8",
    })
    expect("ANTHROPIC_API_KEY" in out).toBe(false)
    expect("ANTHROPIC_AUTH_TOKEN" in out).toBe(false)
    expect("CLAUDECODE" in out).toBe(false)
    expect(out["PATH"]).toBe("/usr/bin")
    expect(out["HOME"]).toBe("/home/x")
    expect(out["LANG"]).toBe("en_US.UTF-8")
    // OAuth token MUST survive — that's the credential we want billing to use.
    expect(out["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("oauth-keep-me")
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
