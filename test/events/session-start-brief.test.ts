import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleSessionStart } from "../../src/events/session-start-brief.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { GitTest } from "../../src/services/git.ts"
import { ProjectTest } from "../../src/services/project.ts"
import { ShellTest } from "../../src/services/shell.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const layer = (
  branch: string,
  porcelain: string,
  cmds: { typecheck?: string | null; lint?: string | null; test?: string | null } = {},
) =>
  Layer.mergeAll(
    GitTest({ branch }),
    ProjectTest({
      typecheck: cmds.typecheck ?? "bun run typecheck",
      lint: cmds.lint ?? "bun run lint",
      test: { targeted: cmds.test ?? "bun test" },
    }),
    ShellTest((cmd) => {
      if (cmd.includes("git ") && cmd.includes("status")) {
        return { stdout: porcelain, stderr: "", exitCode: 0 }
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    }),
  )

describe("handleSessionStart", () => {
  test("brief contains branch, dirty count, verification commands", async () => {
    const payload = decode({
      _tag: "SessionStart",
      session_id: "s",
      hook_event_name: "SessionStart",
    })
    const d = await Effect.runPromise(
      handleSessionStart(payload).pipe(
        Effect.provide(layer("feat/x", " M src/a.ts\n M src/b.ts")),
      ),
    )
    const out = d as { hookSpecificOutput: { additionalContext: string } }
    const ctx = out.hookSpecificOutput.additionalContext
    expect(ctx).toContain("feat/x")
    expect(ctx).toContain("Dirty files: 2")
    expect(ctx).toContain("Typecheck: bun run typecheck")
    expect(ctx).toContain("Lint: bun run lint")
    expect(ctx).toContain("Test: bun test")
    expect(ctx).not.toContain("README")
    expect(ctx.length).toBeLessThan(2048)
  })

  test("dirty list capped at 20", async () => {
    const lines = Array.from({ length: 25 }, (_, i) => ` M src/file${i}.ts`).join("\n")
    const payload = decode({
      _tag: "SessionStart",
      session_id: "s",
      hook_event_name: "SessionStart",
    })
    const d = await Effect.runPromise(
      handleSessionStart(payload).pipe(Effect.provide(layer("main", lines))),
    )
    const ctx = (d as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext
    expect(ctx).toContain("Dirty files: 25")
    expect(ctx).toContain("and 5 more")
  })

  test("summarizes work directories and archives completed work dirs", async () => {
    const root = mkdtempSync(join(tmpdir(), "session-start-brief-"))
    try {
      const completeDir = join(root, ".claude-hooks", "work", "complete-run")
      mkdirSync(completeDir, { recursive: true })
      writeFileSync(
        join(completeDir, "ISA.md"),
        "---\neffort: advanced\nphase: complete\n---\n\n## Goal\nDone\n",
      )
      const payload = decode({
        _tag: "SessionStart",
        session_id: "s",
        hook_event_name: "SessionStart",
        cwd: root,
      })
      const porcelain = [
        "?? .claude-hooks/work/complete-run/ISA.md",
        "?? .claude-hooks/work/active-run/ISA.md",
        " M src/a.ts",
      ].join("\n")
      const d = await Effect.runPromise(
        handleSessionStart(payload).pipe(
          Effect.provide(layer("main", porcelain)),
        ),
      )
      const ctx = (d as { hookSpecificOutput: { additionalContext: string } })
        .hookSpecificOutput.additionalContext
      expect(ctx).toContain("Dirty files: 3")
      expect(ctx).toContain(".claude-hooks/work/: 2 work dirs summarized")
      expect(ctx).toContain("M src/a.ts")
      expect(ctx).toContain("Archived stale work dirs: 1")
      expect(existsSync(completeDir)).toBe(false)
      expect(existsSync(join(root, ".claude-hooks", "archive"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("non-SessionStart payload → NO_DECISION", async () => {
    const payload = decode({
      _tag: "Stop",
      session_id: "s",
      hook_event_name: "Stop",
    })
    const d = await Effect.runPromise(
      handleSessionStart(payload).pipe(Effect.provide(layer("main", ""))),
    )
    expect(d).toEqual({})
  })
})
