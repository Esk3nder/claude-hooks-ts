import { describe, expect, test } from "bun:test"
import { runCommandLive } from "../../src/services/command-runner.ts"
import { scrubClaudeEnv } from "../../src/services/claude-subprocess.ts"

describe("CommandRunner", () => {
  test("runs argv commands and captures stdout", async () => {
    const result = await runCommandLive("printf", ["ok"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("ok")
    expect(result.stderr).toBe("")
    expect(result.timedOut).toBe(false)
  })

  test("returns a timedOut result through Effect timeout policy", async () => {
    const result = await runCommandLive("sh", ["-c", "sleep 1"], {
      timeoutMs: 25,
    })

    expect(result.exitCode).toBe(-1)
    expect(result.timedOut).toBe(true)
    expect(result.stderr).toContain("timed out after 25ms")
  })

  test("caps stdout in the shared runner", async () => {
    const result = await runCommandLive("printf", ["abcdef"], {
      stdoutMaxBytes: 3,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("abc")
    expect(result.stdout).toContain("output truncated at 3 bytes")
  })

  test("preserves multibyte UTF-8 split across process writes", async () => {
    const result = await runCommandLive("bun", [
      "-e",
      [
        "process.stdout.write(Buffer.from([0xe2]));",
        "setTimeout(() => process.stdout.write(Buffer.from([0x82])), 10);",
        "setTimeout(() => process.stdout.write(Buffer.from([0xac])), 20);",
      ].join(""),
    ])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("€")
  })

  test("applies Claude env scrubbing at the runner boundary", async () => {
    const result = await runCommandLive(
      "sh",
      [
        "-c",
        'printf "%s:%s:%s:%s" "$ANTHROPIC_API_KEY" "$ANTHROPIC_AUTH_TOKEN" "$CLAUDECODE" "$CLAUDE_CODE_OAUTH_TOKEN"',
      ],
      {
        env: {
          ANTHROPIC_API_KEY: "blocked",
          ANTHROPIC_AUTH_TOKEN: "blocked",
          CLAUDECODE: "blocked",
          CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
        },
        scrubEnv: scrubClaudeEnv,
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(":::oauth-token")
  })

  test("drops scrubbed env keys instead of forwarding undefined values", async () => {
    const result = await runCommandLive(
      "bun",
      ["-e", "process.stdout.write(process.env.RUNNER_DELETE_ME ?? 'missing')"],
      {
        env: { RUNNER_DELETE_ME: "secret" },
        scrubEnv: (env) => ({ ...env, RUNNER_DELETE_ME: undefined }),
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("missing")
  })
})
