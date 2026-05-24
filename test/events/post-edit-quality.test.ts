import { describe, expect, test } from "bun:test"
import { Effect, Layer, Logger, Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { handlePostToolUse } from "../../src/events/post-edit-quality.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { ProjectTest } from "../../src/services/project.ts"
import { Shell, ShellTest } from "../../src/services/shell.ts"
import { RedactTest } from "../../src/services/redact.ts"
import {
  EMPTY_SESSION_STATE,
  SessionState,
  SessionStateTest,
} from "../../src/services/session-state.ts"
import { ShellError } from "../../src/schema/errors.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const editPayload = (file: string, tool = "Edit") =>
  decode({
    _tag: "PostToolUse",
    session_id: "s",
    hook_event_name: "PostToolUse",
    tool_name: tool,
    tool_input: { file_path: file },
    tool_response: { success: true },
  })

const recordingShell = () => {
  const calls: string[] = []
  const layer = Layer.mergeAll(
    ProjectTest(),
    RedactTest(),
    SessionStateTest(),
    ShellTest((cmd) => {
      calls.push(cmd)
      // Probe via "command -v <name>" — succeed for prettier, fail for ruff
      if (cmd.includes("command -v prettier")) {
        return { stdout: "", stderr: "", exitCode: 0 }
      }
      if (cmd.includes("command -v ")) {
        return { stdout: "", stderr: "", exitCode: 1 }
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    }),
  )
  return { layer, calls }
}

describe("handlePostToolUse (post-edit-quality)", () => {
  test("never blocks; returns NoOp on .ts edit", async () => {
    const { layer } = recordingShell()
    const d = await Effect.runPromise(
      handlePostToolUse(editPayload("/repo/src/foo.ts")).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
  })

  test("invokes prettier when available", async () => {
    const { layer, calls } = recordingShell()
    await Effect.runPromise(
      handlePostToolUse(editPayload("/repo/src/foo.ts")).pipe(Effect.provide(layer)),
    )
    expect(calls.some((c) => c.startsWith("prettier "))).toBe(true)
  })

  test("no-op when formatter not available (ruff probe fails)", async () => {
    const { layer, calls } = recordingShell()
    const d = await Effect.runPromise(
      handlePostToolUse(editPayload("/repo/src/foo.py")).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
    expect(calls.some((c) => c.startsWith("ruff "))).toBe(false)
  })

  test("ignores non-edit tools", async () => {
    const { layer, calls } = recordingShell()
    const payload = decode({
      _tag: "PostToolUse",
      session_id: "s",
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/repo/src/foo.ts" },
      tool_response: { success: true },
    })
    const d = await Effect.runPromise(
      handlePostToolUse(payload).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
    expect(calls.length).toBe(0)
  })

  test("returns additionalContext when tool response contains a secret pattern", async () => {
    const { layer } = recordingShell()
    const payload = decode({
      _tag: "PostToolUse",
      session_id: "s",
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/repo/.env" },
      tool_response: {
        stdout: "token=ghp_abcdefghij1234567890ZZZZ12345xyz",
      },
    })
    const d = await Effect.runPromise(
      handlePostToolUse(payload).pipe(Effect.provide(layer)),
    )
    const out = d as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string }
    }
    expect(out.hookSpecificOutput?.hookEventName).toBe("PostToolUse")
    expect(out.hookSpecificOutput?.additionalContext ?? "").toContain(
      "secret pattern detected",
    )
  })

  test("ignores files without runner extension", async () => {
    const { layer, calls } = recordingShell()
    const d = await Effect.runPromise(
      handlePostToolUse(editPayload("/repo/notes.txt")).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
    expect(calls.length).toBe(0)
  })

  test("never blocks even when shell fails", async () => {
    const layer = Layer.mergeAll(
      ProjectTest(),
      RedactTest(),
      SessionStateTest(),
      ShellTest((cmd) => {
        if (cmd.includes("command -v prettier")) {
          return { stdout: "", stderr: "", exitCode: 0 }
        }
        // formatter run fails
        return { stdout: "", stderr: "boom", exitCode: 2 }
      }),
    )
    const d = await Effect.runPromise(
      handlePostToolUse(editPayload("/repo/src/foo.ts")).pipe(Effect.provide(layer)),
    )
    expect(d).toEqual({})
  })

  test("records single PostToolUse edits as files_changed and resets verification", async () => {
    const layer = Layer.mergeAll(
      ProjectTest(),
      RedactTest(),
      SessionStateTest(
        new Map([
          [
            "s",
            {
              ...EMPTY_SESSION_STATE,
              verification_status: "passed" as const,
              tests_run: ["bun test"],
            },
          ],
        ]),
      ),
      ShellTest(() => ({ stdout: "", stderr: "", exitCode: 1 })),
    )
    const program = Effect.gen(function* () {
      yield* handlePostToolUse(editPayload("/repo/dashboard.html", "Write"))
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(record.files_changed).toContain("/repo/dashboard.html")
    expect(record.verification_status).toBe("none")
    expect(record.next_required_action ?? "").toMatch(/test|typecheck/)
  })

  test("records single PostToolUse verification commands", async () => {
    const layer = Layer.mergeAll(
      ProjectTest(),
      RedactTest(),
      SessionStateTest(),
      ShellTest(() => ({ stdout: "", stderr: "", exitCode: 1 })),
    )
    const payload = decode({
      _tag: "PostToolUse",
      session_id: "s",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "node --check extracted-script.js" },
      tool_response: { exitCode: 0 },
    })
    const program = Effect.gen(function* () {
      yield* handlePostToolUse(payload)
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(record.commands_run).toContain("node --check extracted-script.js")
    expect(record.tests_run).toContain("node --check extracted-script.js")
    expect(record.verification_status).toBe("passed")
  })

  test("missing PostToolUse verification response does not pass", async () => {
    const layer = Layer.mergeAll(
      ProjectTest(),
      RedactTest(),
      SessionStateTest(),
      ShellTest(() => ({ stdout: "", stderr: "", exitCode: 1 })),
    )
    const payload = decode({
      _tag: "PostToolUse",
      session_id: "s",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "node --check extracted-script.js" },
      tool_response: undefined,
    })
    const program = Effect.gen(function* () {
      yield* handlePostToolUse(payload)
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(record.commands_failed).toContain("node --check extracted-script.js")
    expect(record.tests_run).toContain("node --check extracted-script.js")
    expect(record.verification_status).toBe("failed")
  })

  test("does not treat incidental words like latest as verification", async () => {
    const layer = Layer.mergeAll(
      ProjectTest(),
      RedactTest(),
      SessionStateTest(),
      ShellTest(() => ({ stdout: "", stderr: "", exitCode: 1 })),
    )
    const payload = decode({
      _tag: "PostToolUse",
      session_id: "s",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "rg latest src" },
      tool_response: { exitCode: 0 },
    })
    const program = Effect.gen(function* () {
      yield* handlePostToolUse(payload)
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(record.commands_run).toContain("rg latest src")
    expect(record.tests_run).not.toContain("rg latest src")
    expect(record.verification_status).toBe("none")
  })

  test("does not treat echoed verification words as a verification command", async () => {
    const layer = Layer.mergeAll(
      ProjectTest(),
      RedactTest(),
      SessionStateTest(),
      ShellTest(() => ({ stdout: "", stderr: "", exitCode: 1 })),
    )
    const payload = decode({
      _tag: "PostToolUse",
      session_id: "s",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo bun test" },
      tool_response: { exitCode: 0 },
    })
    const program = Effect.gen(function* () {
      yield* handlePostToolUse(payload)
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(record.commands_run).toContain("echo bun test")
    expect(record.tests_run).not.toContain("echo bun test")
    expect(record.verification_status).toBe("none")
  })

  test("does not record failed edit tools as changed files", async () => {
    const layer = Layer.mergeAll(
      ProjectTest(),
      RedactTest(),
      SessionStateTest(),
      ShellTest(() => ({ stdout: "", stderr: "", exitCode: 1 })),
    )
    const payload = decode({
      _tag: "PostToolUse",
      session_id: "s",
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/repo/dashboard.html" },
      tool_response: { success: false, error: "permission denied" },
    })
    const program = Effect.gen(function* () {
      yield* handlePostToolUse(payload)
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(record.files_changed).not.toContain("/repo/dashboard.html")
    expect(record.verification_status).toBe("none")
    expect(record.next_required_action).toBeNull()
  })

  // Hook meta-artifact loop fix: ISA.md and .claude-hooks/verify-map.yaml
  // are documentation OF verification, not subjects of it. Recording them
  // in files_changed creates a self-trap: the Stop gate demands
  // verification, the model edits the ISA, that edit re-enters
  // files_changed, indefinitely.
  test("does not record ISA.md edits in files_changed (loop self-trap)", async () => {
    const layer = Layer.mergeAll(
      ProjectTest(),
      RedactTest(),
      SessionStateTest(
        new Map([
          [
            "s",
            {
              ...EMPTY_SESSION_STATE,
              files_changed: ["/repo/src/already-verified.ts"],
              verification_status: "passed" as const,
            },
          ],
        ]),
      ),
      ShellTest(() => ({ stdout: "", stderr: "", exitCode: 1 })),
    )
    const isaPath = "/repo/.claude-hooks/work/abc123/ISA.md"
    const program = Effect.gen(function* () {
      yield* handlePostToolUse(editPayload(isaPath, "Write"))
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(record.files_changed).not.toContain(isaPath)
    expect(record.meta_artifacts_changed).toContain(isaPath)
    expect(record.verification_status).toBe("passed")
    expect(record.next_required_action ?? "").toContain("meta-artifact")
  })

  test("does not record .claude-hooks/verify-map.yaml edits in files_changed", async () => {
    const layer = Layer.mergeAll(
      ProjectTest(),
      RedactTest(),
      SessionStateTest(),
      ShellTest(() => ({ stdout: "", stderr: "", exitCode: 1 })),
    )
    const vmPath = "/repo/.claude-hooks/verify-map.yaml"
    const program = Effect.gen(function* () {
      yield* handlePostToolUse(editPayload(vmPath, "Edit"))
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(record.files_changed).not.toContain(vmPath)
    expect(record.meta_artifacts_changed).toContain(vmPath)
    expect(record.next_required_action ?? "").toContain("meta-artifact")
  })

  test("does not record .claude-hooks/state/<sid>.json edits in files_changed", async () => {
    const layer = Layer.mergeAll(
      ProjectTest(),
      RedactTest(),
      SessionStateTest(
        new Map([
          ["s", { ...EMPTY_SESSION_STATE, session_root: "/repo" }],
        ]),
      ),
      ShellTest(() => ({ stdout: "", stderr: "", exitCode: 1 })),
    )
    // Model-side edits to the hook-owned session-state JSON would otherwise
    // pollute `files_changed` and re-arm the Stop verify loop. The repair
    // edits a user might perform to escape a corrupt-state Stop loop must
    // not themselves trigger the next loop.
    const statePath =
      "/repo/.claude-hooks/state/5cd1922e-a5a3-4457-8fd1-f65e2c53bbef.json"
    const program = Effect.gen(function* () {
      yield* handlePostToolUse(editPayload(statePath, "Write"))
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(record.files_changed).not.toContain(statePath)
    expect(record.meta_artifacts_changed).toContain(statePath)
  })

  test("does not record .claude-hooks/work/<sid>/<artifact> edits in files_changed", async () => {
    const layer = Layer.mergeAll(
      ProjectTest(),
      RedactTest(),
      SessionStateTest(
        new Map([
          ["s", { ...EMPTY_SESSION_STATE, session_root: "/repo" }],
        ]),
      ),
      ShellTest(() => ({ stdout: "", stderr: "", exitCode: 1 })),
    )
    // Non-ISA artifacts in the work dir (e.g. checkpoints, notes) are also
    // hook-owned bookkeeping, not subjects of code verification.
    const workArtifact = "/repo/.claude-hooks/work/abc123/notes.md"
    const program = Effect.gen(function* () {
      yield* handlePostToolUse(editPayload(workArtifact, "Edit"))
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(record.files_changed).not.toContain(workArtifact)
    expect(record.meta_artifacts_changed).toContain(workArtifact)
  })

  test("records foreign verify-map.yaml edits as files_changed when cwd scopes the active config", async () => {
    const layer = Layer.mergeAll(
      ProjectTest(),
      RedactTest(),
      SessionStateTest(),
      ShellTest(() => ({ stdout: "", stderr: "", exitCode: 1 })),
    )
    const foreignPath = "/repo/fixtures/.claude-hooks/verify-map.yaml"
    const payload = decode({
      _tag: "PostToolUse",
      session_id: "s",
      hook_event_name: "PostToolUse",
      cwd: "/repo",
      tool_name: "Edit",
      tool_input: { file_path: foreignPath },
      tool_response: { success: true },
    })
    const program = Effect.gen(function* () {
      yield* handlePostToolUse(payload)
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(record.files_changed).toContain(foreignPath)
    expect(record.meta_artifacts_changed).not.toContain(foreignPath)
    expect(record.verification_status).toBe("none")
  })

  test("records single PostToolUse source URLs from web tools", async () => {
    const layer = Layer.mergeAll(
      ProjectTest(),
      RedactTest(),
      SessionStateTest(),
      ShellTest(() => ({ stdout: "", stderr: "", exitCode: 1 })),
    )
    const payload = decode({
      _tag: "PostToolUse",
      session_id: "s",
      hook_event_name: "PostToolUse",
      tool_name: "WebSearch",
      tool_input: { query: "commercial roofing benchmarks" },
      tool_response: {
        results: [
          { url: "https://example.com/roofing-benchmark" },
          { url: "https://example.com/roofing-benchmark" },
        ],
      },
    })
    const program = Effect.gen(function* () {
      yield* handlePostToolUse(payload)
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(record.source_urls).toEqual(["https://example.com/roofing-benchmark"])
  })

  test("records source URLs from source tool UI aliases", async () => {
    const layer = Layer.mergeAll(
      ProjectTest(),
      RedactTest(),
      SessionStateTest(),
      ShellTest(() => ({ stdout: "", stderr: "", exitCode: 1 })),
    )
    const payload = decode({
      _tag: "PostToolUse",
      session_id: "s",
      hook_event_name: "PostToolUse",
      tool_name: "Web Search",
      tool_input: { query: "benchmarks" },
      tool_response: "Result: https://example.com/current-benchmark",
    })
    const program = Effect.gen(function* () {
      yield* handlePostToolUse(payload)
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(record.source_urls).toEqual(["https://example.com/current-benchmark"])
  })

  test("does not treat URLs in search queries as fetched source evidence", async () => {
    const layer = Layer.mergeAll(
      ProjectTest(),
      RedactTest(),
      SessionStateTest(),
      ShellTest(() => ({ stdout: "", stderr: "", exitCode: 1 })),
    )
    const payload = decode({
      _tag: "PostToolUse",
      session_id: "s",
      hook_event_name: "PostToolUse",
      tool_name: "WebSearch",
      tool_input: { query: "Read https://example.com/current-benchmark" },
      tool_response: "Did 1 search in 6s",
    })
    const program = Effect.gen(function* () {
      yield* handlePostToolUse(payload)
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(record.source_urls).toEqual([])
  })

  test("does not record dead fetch URLs as usable source evidence", async () => {
    const layer = Layer.mergeAll(
      ProjectTest(),
      RedactTest(),
      SessionStateTest(),
      ShellTest(() => ({ stdout: "", stderr: "", exitCode: 1 })),
    )
    const payload = decode({
      _tag: "PostToolUse",
      session_id: "s",
      hook_event_name: "PostToolUse",
      tool_name: "WebFetch",
      tool_input: { url: "https://example.com/dead", prompt: "extract" },
      tool_response: "Received 0 bytes (404 Not Found)",
    })
    const program = Effect.gen(function* () {
      yield* handlePostToolUse(payload)
      const state = yield* SessionState
      return yield* state.get("s")
    })
    const record = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(record.source_urls).toEqual([])
  })
})


describe("handlePostToolUse — silent failure logging (M9 fix #2)", () => {
  test("logs warning when shell errors on probe", async () => {
    const captured: string[] = []
    const logger = Logger.make(({ message }) => {
      captured.push(String(message))
    })
    const failingShell = Layer.succeed(
      Shell,
      Shell.of({
        run: () =>
          Effect.fail(
            new ShellError({
              command: "sh -c 'command -v prettier >/dev/null 2>&1'",
              exitCode: -1,
              stderr: "permission denied opening exec",
              message: "EACCES: permission denied",
            }),
          ),
      }),
    )
    const layer = Layer.mergeAll(
      ProjectTest(),
      RedactTest(),
      SessionStateTest(),
      failingShell,
    )
    const d = await Effect.runPromise(
      handlePostToolUse(editPayload("/repo/src/foo.ts")).pipe(
        Effect.provide(layer),
        Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
      ),
    )
    expect(d).toEqual({})
    const joined = captured.join("")
    expect(joined).toContain("post-edit-quality:")
    expect(joined).toContain("failed; continuing:")
    expect(joined).toContain("sh")
  })
})

/**
 * Regression: probe runner only scanned `<root>/.claude-hooks/state/work/<slug>/ISA.md`
 * via findLatestISA(). Project-root ISAs (the second canonical home per
 * IsaFormat.md lines 56-57 — what the README documents) were invisible to the
 * probe runner even though the doctor and TaskCompleted/Stop gates found them.
 * Result: probe → ISC-flip → checkpoint chain was dead for any user following
 * the documented setup. Fix is `findLatestISA() ?? findProjectIsa()`.
 */
describe("probe runner: project-root ISA discovery", () => {
  test("flips ISC when only <root>/ISA.md exists (no state/work/)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "probe-root-isa-"))
    const origCwd = process.cwd()
    try {
      fs.mkdirSync(path.join(tmp, ".claude-hooks"), { recursive: true })
      fs.writeFileSync(
        path.join(tmp, ".claude-hooks", "probes.ts"),
        'export const probes = { "tests-pass": async () => true }\n',
      )
      const isa = path.join(tmp, "ISA.md")
      fs.writeFileSync(
        isa,
        `---
slug: probe-root-isa-test
phase: in_progress
tier: E3
---
# ISA
## Problem
Verify probe runner finds project-root ISA.
## Ideal State Criteria
- [ ] ISC-1 — placeholder probe returns true
## Test Strategy
| isc   | type | check | threshold | tool       |
|-------|------|-------|-----------|------------|
| ISC-1 | bun  | smoke | n/a       | tests-pass |
## Verification
Run \`bun test\`.
`,
      )
      process.chdir(tmp)
      const { layer } = recordingShell()
      const payload = decode({
        _tag: "PostToolUse",
        session_id: "probe-root-test",
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: path.join(tmp, "scratch.txt") },
        tool_response: { success: true },
      })
      await Effect.runPromise(
        handlePostToolUse(payload).pipe(Effect.provide(layer)),
      )
      const after = fs.readFileSync(isa, "utf8")
      expect(after).toContain("- [x] ISC-1")
      expect(after).not.toContain("- [ ] ISC-1")
    } finally {
      process.chdir(origCwd)
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
