import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { handlePostToolUse } from "../../src/events/post-edit-quality.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { ProjectTest } from "../../src/services/project.ts"
import { Shell, ShellTest } from "../../src/services/shell.ts"
import { RedactTest } from "../../src/services/redact.ts"
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
})


describe("handlePostToolUse — silent failure logging (M9 fix #2)", () => {
  test("emits stderr warning when shell errors on probe", async () => {
    const captured: string[] = []
    const origWrite = process.stderr.write.bind(process.stderr)
    ;(process.stderr.write as unknown) = (
      chunk: string | Uint8Array,
    ): boolean => {
      const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
      captured.push(s)
      return true
    }
    try {
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
      const layer = Layer.mergeAll(ProjectTest(), RedactTest(), failingShell)
      const d = await Effect.runPromise(
        handlePostToolUse(editPayload("/repo/src/foo.ts")).pipe(Effect.provide(layer)),
      )
      expect(d).toEqual({})
      const joined = captured.join("")
      expect(joined).toContain("post-edit-quality:")
      expect(joined).toContain("failed silently:")
      expect(joined).toContain("sh")
    } finally {
      ;(process.stderr.write as unknown) = origWrite
    }
  })
})
