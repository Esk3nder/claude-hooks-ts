/**
 * Regression pins for the three audit residuals closed together:
 *
 *   US-23     — CommandRunner env-scrub vs Bun parent-process injection
 *   EP P2 #8  — verification metadata recording
 *   EP P2 #9  — verify-map glob `*` is single-segment
 *
 * US-23 has its primary pin in `test/services/command-runner.test.ts`
 * and #9 has its in `test/policies/verify-map.test.ts`; this file
 * focuses on #8 (which spans session-state + post-edit-quality) and
 * adds a cross-cutting #9 + scrubClaudeEnv shape test.
 */

import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { handlePostToolUse } from "../src/events/post-edit-quality.ts"
import { HookPayload } from "../src/schema/payloads.ts"
import { ProjectTest } from "../src/services/project.ts"
import { RedactTest } from "../src/services/redact.ts"
import { ShellTest } from "../src/services/shell.ts"
import {
  EMPTY_SESSION_STATE,
  SessionState,
  SessionStateTest,
} from "../src/services/session-state.ts"
import { scrubClaudeEnv } from "../src/services/claude-subprocess.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const verificationLayer = (initialFilesChanged: string[]) =>
  Layer.mergeAll(
    ProjectTest(),
    RedactTest(),
    SessionStateTest(
      new Map([
        [
          "s",
          {
            ...EMPTY_SESSION_STATE,
            files_changed: initialFilesChanged,
          },
        ],
      ]),
    ),
    ShellTest(() => ({ stdout: "", stderr: "", exitCode: 0 })),
  )

describe("EP P2 #8 — verification metadata recording", () => {
  test("verification command + matched file recorded when bun test runs after edit", async () => {
    const layer = verificationLayer(["/repo/src/foo.ts"])
    const payload = decode({
      _tag: "PostToolUse",
      session_id: "s",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "bun test test/foo.test.ts" },
      tool_response: { exitCode: 0 },
    })
    const program = Effect.gen(function* () {
      yield* handlePostToolUse(payload)
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(record.verification_status).toBe("passed")
    expect(record.verification_command).toBe("bun test test/foo.test.ts")
    expect(record.verification_files).toContain("/repo/src/foo.ts")
  })

  test("verification command recorded with empty matched-files when unrelated", async () => {
    // The "P2 #8" finding: an unrelated bun test command satisfies
    // verification but doesn't actually cover the changed file. This
    // test pins the AUDIT signal — verification_files is [] —
    // letting a reviewer see that nothing was actually covered.
    const layer = verificationLayer(["/repo/src/foo.ts"])
    const payload = decode({
      _tag: "PostToolUse",
      session_id: "s",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "bun test test/unrelated.test.ts" },
      tool_response: { exitCode: 0 },
    })
    const program = Effect.gen(function* () {
      yield* handlePostToolUse(payload)
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(record.verification_status).toBe("passed")
    expect(record.verification_command).toBe("bun test test/unrelated.test.ts")
    expect(record.verification_files).toEqual([])
  })

  test("multiple changed files: each-basename-in-command matches", async () => {
    const layer = verificationLayer([
      "/repo/src/foo.ts",
      "/repo/src/bar.ts",
      "/repo/src/baz.ts",
    ])
    const payload = decode({
      _tag: "PostToolUse",
      session_id: "s",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: {
        command: "bun test test/foo.test.ts test/bar.test.ts",
      },
      tool_response: { exitCode: 0 },
    })
    const program = Effect.gen(function* () {
      yield* handlePostToolUse(payload)
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(record.verification_files).toContain("/repo/src/foo.ts")
    expect(record.verification_files).toContain("/repo/src/bar.ts")
    expect(record.verification_files).not.toContain("/repo/src/baz.ts")
  })

  test("non-verification command does not record metadata", async () => {
    const layer = verificationLayer(["/repo/src/foo.ts"])
    const payload = decode({
      _tag: "PostToolUse",
      session_id: "s",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      tool_response: { exitCode: 0 },
    })
    const program = Effect.gen(function* () {
      yield* handlePostToolUse(payload)
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(record.verification_status).toBe("none")
    expect(record.verification_command ?? null).toBe(null)
  })
})

describe("US-23 — scrubClaudeEnv masking behavior", () => {
  test("scrubbed keys are EMPTY STRINGS (mask), not absent (drop)", () => {
    const input: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: "secret-key",
      ANTHROPIC_AUTH_TOKEN: "secret-token",
      CLAUDECODE: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "ok",
      HOME: "/home/u",
    }
    const out = scrubClaudeEnv(input)
    expect(out["ANTHROPIC_API_KEY"]).toBe("")
    expect(out["ANTHROPIC_AUTH_TOKEN"]).toBe("")
    expect(out["CLAUDECODE"]).toBe("")
    // Non-scrubbed keys preserved
    expect(out["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("ok")
    expect(out["HOME"]).toBe("/home/u")
  })

  test("scrub target keys are ALWAYS present even if not in source", () => {
    // The security boundary: even an empty source env must mask
    // these so the executor's parent-env merge can't introduce
    // them post-scrub.
    const out = scrubClaudeEnv({})
    expect(out["ANTHROPIC_API_KEY"]).toBe("")
    expect(out["ANTHROPIC_AUTH_TOKEN"]).toBe("")
    expect(out["CLAUDECODE"]).toBe("")
  })
})
