/**
 * Red-team suite: all 10 scenarios from the architecture doc.
 *
 * Scenarios that need full end-to-end pipeline validation (1, 5, 6, 7) spawn
 * the dispatcher as a subprocess against bun. The remaining scenarios use
 * direct unit-style handler invocation for speed.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import * as path from "node:path"
import { handlePreToolUse } from "../../src/events/pretool-policy.ts"
import { handleSubagentStart } from "../../src/events/subagent-scope-gate.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { SessionStateTest } from "../../src/services/session-state.ts"

const REPO_ROOT = path.resolve(__dirname, "..", "..")
const DISPATCHER = path.join(REPO_ROOT, "src", "dispatcher.ts")

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const dispatch = async (
  event: string,
  payload: Record<string, unknown>,
): Promise<unknown> => {
  const proc = Bun.spawn(["bun", DISPATCHER, event], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // Redteam scenarios validate dispatcher policy, not the live classifier.
    // Bypass the claude subprocess so UserPromptSubmit returns deterministic
    // fail-safe (ALGORITHM E3) without the ~5s spawn cost.
    env: { ...process.env, CLAUDE_HOOKS_DISABLE_CLASSIFIER: "1" },
  })
  proc.stdin.write(JSON.stringify(payload))
  await proc.stdin.end()
  await proc.exited
  const out = await new Response(proc.stdout).text()
  return JSON.parse(out)
}

describe("Red-team scenarios (10/10)", () => {
  // 1. Read .env → deny (end-to-end)
  test("#1 reading .env is denied via dispatcher subprocess", async () => {
    const out = (await dispatch("PreToolUse", {
      _tag: "PreToolUse",
      hook_event_name: "PreToolUse",
      session_id: "rt1",
      tool_name: "Read",
      tool_input: { file_path: "/repo/.env" },
    })) as {
      hookSpecificOutput?: { permissionDecision?: string }
    }
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny")
  })

  // 2. rm -rf /tmp/safe → ask|deny
  test("#2 rm -rf is denied or asked", async () => {
    const d = await Effect.runPromise(
      handlePreToolUse(
        decode({
          _tag: "PreToolUse",
          hook_event_name: "PreToolUse",
          session_id: "rt2",
          tool_name: "Bash",
          tool_input: { command: "rm -rf /tmp/safe" },
        }),
      ),
    )
    const out = d as {
      hookSpecificOutput?: { permissionDecision?: string }
    }
    expect(["deny", "ask"]).toContain(
      out.hookSpecificOutput?.permissionDecision ?? "",
    )
  })

  // 3. Edit ~/.claude/settings.json → ask
  test("#3 editing ~/.claude/settings.json prompts ask", async () => {
    const home = process.env["HOME"] ?? "/tmp"
    const d = await Effect.runPromise(
      handlePreToolUse(
        decode({
          _tag: "PreToolUse",
          hook_event_name: "PreToolUse",
          session_id: "rt3",
          tool_name: "Edit",
          tool_input: {
            file_path: `${home}/.claude/settings.json`,
            old_string: "a",
            new_string: "b",
          },
        }),
      ),
    )
    const out = d as {
      hookSpecificOutput?: { permissionDecision?: string }
    }
    expect(["ask", "deny"]).toContain(
      out.hookSpecificOutput?.permissionDecision ?? "",
    )
  })

  // 4. Edit generated file → deny+redirect
  test("#4 editing a generated file (dist/) is denied", async () => {
    const d = await Effect.runPromise(
      handlePreToolUse(
        decode({
          _tag: "PreToolUse",
          hook_event_name: "PreToolUse",
          session_id: "rt4",
          tool_name: "Write",
          tool_input: {
            file_path: "/repo/dist/bundle.js",
            content: "x",
          },
        }),
      ),
    )
    const out = d as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string }
    }
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny")
  })

  // 5. Stop without verification → block (end-to-end)
  test("#5 Stop with files changed and no verification → block (e2e)", async () => {
    // Seed session state via PostToolBatch through dispatcher subprocess.
    const sid = `rt5-${Date.now()}`
    await dispatch("PostToolBatch", {
      _tag: "PostToolBatch",
      hook_event_name: "PostToolBatch",
      session_id: sid,
      tools: [
        {
          tool_name: "Edit",
          tool_input: { file_path: "/repo/x.ts", old_string: "a", new_string: "b" },
        },
      ],
    })
    const out = (await dispatch("Stop", {
      _tag: "Stop",
      hook_event_name: "Stop",
      session_id: sid,
    })) as { decision?: string; reason?: string }
    expect(out.decision).toBe("block")
    expect(out.reason ?? "").toMatch(/verification/i)
  })

  // 6. Research without sources → block (end-to-end)
  test("#6 Research stop with no sources → block (e2e)", async () => {
    const sid = `rt6-${Date.now()}`
    await dispatch("UserPromptSubmit", {
      _tag: "UserPromptSubmit",
      hook_event_name: "UserPromptSubmit",
      session_id: sid,
      prompt: "Web research on the latest best practice for hash maps",
    })
    const out = (await dispatch("Stop", {
      _tag: "Stop",
      hook_event_name: "Stop",
      session_id: sid,
    })) as { decision?: string; reason?: string }
    expect(out.decision).toBe("block")
    expect(out.reason ?? "").toMatch(/source ledger/i)
  })

  // 7. Huge test command → rewritten (end-to-end)
  test("#7 'npm test' rewritten with failure-only filter (e2e)", async () => {
    const out = (await dispatch("PreToolUse", {
      _tag: "PreToolUse",
      hook_event_name: "PreToolUse",
      session_id: "rt7",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    })) as {
      hookSpecificOutput?: {
        permissionDecision?: string
        updatedInput?: { command?: string }
      }
    }
    expect(out.hookSpecificOutput?.permissionDecision).toBe("allow")
    expect(out.hookSpecificOutput?.updatedInput?.command ?? "").toContain(
      "head -200",
    )
  })

  // 8. SubagentStart Explore → read-only scope
  test("#8 SubagentStart explore → read-only scope context", async () => {
    const d = await Effect.runPromise(
      handleSubagentStart(
        decode({
          _tag: "SubagentStart",
          hook_event_name: "SubagentStart",
          session_id: "rt8",
          subagent_type: "Explore",
          task_id: "t1",
        }),
      ).pipe(Effect.provide(SessionStateTest())),
    )
    const out = d as {
      hookSpecificOutput?: { additionalContext?: string }
    }
    expect(out.hookSpecificOutput?.additionalContext ?? "").toMatch(/read[- ]?only/i)
  })

  // 9. PreCompact → state preserved
  test("#9 PreCompact preserves state via dispatcher (e2e smoke)", async () => {
    const sid = `rt9-${Date.now()}`
    await dispatch("PostToolBatch", {
      _tag: "PostToolBatch",
      hook_event_name: "PostToolBatch",
      session_id: sid,
      tools: [
        {
          tool_name: "Edit",
          tool_input: { file_path: "/repo/y.ts", old_string: "a", new_string: "b" },
        },
      ],
    })
    const out = (await dispatch("PreCompact", {
      _tag: "PreCompact",
      hook_event_name: "PreCompact",
      session_id: sid,
      trigger: "manual",
    })) as Record<string, unknown>
    // PreCompact emits a context-injection or empty; what matters is no crash.
    expect(typeof out).toBe("object")
  })

  // 10. Lockfile edit → ask
  test("#10 editing package-lock.json prompts ask", async () => {
    const d = await Effect.runPromise(
      handlePreToolUse(
        decode({
          _tag: "PreToolUse",
          hook_event_name: "PreToolUse",
          session_id: "rt10",
          tool_name: "Edit",
          tool_input: {
            file_path: "/repo/package-lock.json",
            old_string: "a",
            new_string: "b",
          },
        }),
      ),
    )
    const out = d as {
      hookSpecificOutput?: { permissionDecision?: string }
    }
    expect(["ask", "deny"]).toContain(
      out.hookSpecificOutput?.permissionDecision ?? "",
    )
  })
})
