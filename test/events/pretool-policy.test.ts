import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handlePreToolUse } from "../../src/events/pretool-policy.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { PreToolUseDecision } from "../../src/schema/decisions.ts"
import {
  EMPTY_SESSION_STATE,
  SessionStateTest,
} from "../../src/services/session-state.ts"
import { RuntimeConfigTest } from "../../src/services/runtime-config.ts"
import { EventStoreLive } from "../../src/services/event-store.ts"
import { WorkerRuns, WorkerRunsLive } from "../../src/services/worker-runs.ts"
import {
  CURRENT_WORKER_CONTRACT_HASH,
  CURRENT_WORKER_CONTRACT_VERSION,
  WORKER_CONTRACT_MARKER,
  appendWorkerContract,
} from "../../src/policies/worker-contract.ts"

const payload = (toolName: string, toolInput: unknown) => {
  const raw = {
    _tag: "PreToolUse",
    session_id: "s",
    transcript_path: "/tmp/t",
    cwd: "/tmp",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
  }
  return Schema.decodeUnknownSync(HookPayload)(raw)
}

const run = async (toolName: string, toolInput: unknown) => {
  const result = await Effect.runPromise(
    handlePreToolUse(payload(toolName, toolInput)).pipe(
      Effect.provide(SessionStateTest()),
    ),
  )
  return result as Record<string, unknown>
}

const expectDecision = (
  d: Record<string, unknown>,
  kind: "allow" | "deny" | "ask",
) => {
  Schema.decodeUnknownSync(PreToolUseDecision)(d)
  const inner = (d as { hookSpecificOutput: { permissionDecision: string } })
    .hookSpecificOutput
  expect(inner.permissionDecision).toBe(kind)
}

const workerResult = {
  summary: "worker completed",
  files_relevant: [],
  changes_made: [],
  commands_run: [],
  verification: [{ check: "worker test", status: "passed", evidence: "passed" }],
  risks: [],
  blockers: [],
  confidence: "high",
} as const

describe("handlePreToolUse — red-team M2 assertions", () => {
  // VAL-M2-001
  test("VAL-M2-001: Read .env → deny", async () => {
    const d = await run("Read", { file_path: "/Users/x/proj/.env" })
    expectDecision(d, "deny")
  })

  // VAL-M2-002
  test("VAL-M2-002: Bash rm -rf /tmp/x → ask or deny", async () => {
    const d = await run("Bash", { command: "rm -rf /tmp/x" })
    const inner = (d as { hookSpecificOutput: { permissionDecision: string } })
      .hookSpecificOutput
    expect(["ask", "deny"]).toContain(inner.permissionDecision)
  })
  test("VAL-M2-002: Bash git reset --hard → deny", async () => {
    const d = await run("Bash", { command: "git reset --hard HEAD" })
    expectDecision(d, "deny")
  })
  test("VAL-M2-002: Bash sudo rm → deny", async () => {
    const d = await run("Bash", { command: "sudo rm -rf /var/log/foo" })
    expectDecision(d, "deny")
  })
  test("VAL-M2-002: Bash git clean -fdx → deny", async () => {
    const d = await run("Bash", { command: "git clean -fdx" })
    expectDecision(d, "deny")
  })
  test("VAL-M2-002: Bash drop database → deny", async () => {
    const d = await run("Bash", { command: "psql -c 'DROP DATABASE prod'" })
    expectDecision(d, "deny")
  })
  test("VAL-M2-002: Bash terraform destroy → deny", async () => {
    const d = await run("Bash", { command: "terraform destroy -auto-approve" })
    expectDecision(d, "deny")
  })

  // VAL-M2-003
  test("VAL-M2-003: Edit ~/.claude/settings.json → ask", async () => {
    const d = await run("Edit", {
      file_path: "/Users/x/.claude/settings.json",
      old_string: "a",
      new_string: "b",
    })
    expectDecision(d, "ask")
  })
  test("VAL-M2-003: Write .claude/hooks/foo.mjs → ask", async () => {
    const d = await run("Write", {
      file_path: "/repo/.claude/hooks/foo.mjs",
      content: "x",
    })
    expectDecision(d, "ask")
  })

  // VAL-M2-004
  test("VAL-M2-004: Edit dist/index.js → deny + redirect", async () => {
    const d = await run("Edit", {
      file_path: "/repo/dist/index.js",
      old_string: "a",
      new_string: "b",
    })
    expectDecision(d, "deny")
    const reason = (d as { hookSpecificOutput: { permissionDecisionReason: string } })
      .hookSpecificOutput.permissionDecisionReason
    expect(reason).toContain("src")
  })
  test("VAL-M2-004: Write *.generated.ts → deny + redirect", async () => {
    const d = await run("Write", {
      file_path: "/repo/src/api.generated.ts",
      content: "x",
    })
    expectDecision(d, "deny")
    const reason = (d as { hookSpecificOutput: { permissionDecisionReason: string } })
      .hookSpecificOutput.permissionDecisionReason
    expect(reason.toLowerCase()).toMatch(/template|generator|schema/)
  })

  // VAL-M2-005
  test("VAL-M2-005: Edit package-lock.json → ask", async () => {
    const d = await run("Edit", {
      file_path: "/repo/package-lock.json",
      old_string: "a",
      new_string: "b",
    })
    expectDecision(d, "ask")
  })
  test("VAL-M2-005: Edit pnpm-lock.yaml → ask", async () => {
    const d = await run("Edit", {
      file_path: "/repo/pnpm-lock.yaml",
      old_string: "a",
      new_string: "b",
    })
    expectDecision(d, "ask")
  })
  test("VAL-M2-005: Write Cargo.lock → ask", async () => {
    const d = await run("Write", {
      file_path: "/repo/Cargo.lock",
      content: "x",
    })
    expectDecision(d, "ask")
  })

  // Negative / no-over-block
  test("allow path: Bash git status → no decision (passthrough)", async () => {
    const d = await run("Bash", { command: "git status" })
    expect(d).toEqual({})
  })
  test("allow path: Read src/foo.ts → no decision (passthrough)", async () => {
    const d = await run("Read", { file_path: "/repo/src/foo.ts" })
    expect(d).toEqual({})
  })
  test("allow path: Write src/new.ts → no decision (passthrough)", async () => {
    const d = await run("Write", { file_path: "/repo/src/new.ts", content: "x" })
    expect(d).toEqual({})
  })

  test("worker-mandatory configured min tier reaches pretool gate", async () => {
    const sid = "s"
    const seed = new Map([
      [
        sid,
        {
          ...EMPTY_SESSION_STATE,
          last_mode: "ALGORITHM",
          last_tier: 3,
        },
      ],
    ])
    const layer = Layer.mergeAll(
      SessionStateTest(seed),
      RuntimeConfigTest({
        workerMandatoryMode: "strict",
        workerMandatoryMinTier: 3,
      }),
    )

    const d = await Effect.runPromise(
      handlePreToolUse(
        payload("Write", { file_path: "/repo/src/new.ts", content: "x" }),
      ).pipe(Effect.provide(layer)),
    )

    expectDecision(d as Record<string, unknown>, "deny")
    const reason = (
      d as { hookSpecificOutput: { permissionDecisionReason: string } }
    ).hookSpecificOutput.permissionDecisionReason
    expect(reason).toContain("tier ≥ E3")
  })

  test("worker-mandatory configured min tier E5 lets E4 writes pass through pretool", async () => {
    const sid = "s"
    const seed = new Map([
      [
        sid,
        {
          ...EMPTY_SESSION_STATE,
          last_mode: "ALGORITHM",
          last_tier: 4,
        },
      ],
    ])
    const layer = Layer.mergeAll(
      SessionStateTest(seed),
      RuntimeConfigTest({
        workerMandatoryMode: "strict",
        workerMandatoryMinTier: 5,
      }),
    )

    const d = await Effect.runPromise(
      handlePreToolUse(
        payload("Write", { file_path: "/repo/src/new.ts", content: "x" }),
      ).pipe(Effect.provide(layer)),
    )

    expect(d).toEqual({})
  })

  test("worker-mandatory ignores stale session counters when worker ledger is terminal", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-pretool-worker-ledger-"))
    try {
      const seed = new Map([
        [
          "s",
          {
            ...EMPTY_SESSION_STATE,
            last_mode: "ALGORITHM",
            last_tier: 4,
            subagent_starts: ["s:Explore:a1"],
            subagent_stops: [],
          },
        ],
      ])
      const layer = Layer.mergeAll(
        SessionStateTest(seed),
        RuntimeConfigTest({ workerMandatoryMode: "strict" }),
        Layer.provide(WorkerRunsLive(root), EventStoreLive),
      )

      const d = await Effect.runPromise(
        Effect.gen(function* () {
          const runs = yield* WorkerRuns
          yield* runs.createQueued({
            worker_id: "worker-terminal",
            session_id: "s",
            agent_type: "Explore",
            mode: "read-only",
            prompt_hash: "prompt-hash",
            scope: "src/**",
          })
          yield* runs.complete("worker-terminal", workerResult)
          return yield* handlePreToolUse(
            payload("Write", { file_path: "/repo/src/new.ts", content: "x" }),
          )
        }).pipe(Effect.provide(layer)),
      )

      expectDecision(d as Record<string, unknown>, "deny")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("worker-mandatory allows direct writes while the worker ledger has an active run", async () => {
    const root = mkdtempSync(join(tmpdir(), "chts-pretool-worker-ledger-"))
    try {
      const seed = new Map([
        [
          "s",
          {
            ...EMPTY_SESSION_STATE,
            last_mode: "ALGORITHM",
            last_tier: 4,
          },
        ],
      ])
      const layer = Layer.mergeAll(
        SessionStateTest(seed),
        RuntimeConfigTest({ workerMandatoryMode: "strict" }),
        Layer.provide(WorkerRunsLive(root), EventStoreLive),
      )

      const d = await Effect.runPromise(
        Effect.gen(function* () {
          const runs = yield* WorkerRuns
          yield* runs.createQueued({
            worker_id: "worker-active",
            session_id: "s",
            agent_type: "Explore",
            mode: "read-only",
            prompt_hash: "prompt-hash",
            scope: "src/**",
          })
          yield* runs.markRunning("worker-active")
          return yield* handlePreToolUse(
            payload("Write", { file_path: "/repo/src/new.ts", content: "x" }),
          )
        }).pipe(Effect.provide(layer)),
      )

      expectDecision(d as Record<string, unknown>, "allow")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("worker-mandatory does not block writes from inside a worker session", async () => {
    const seed = new Map([
      [
        "s",
        {
          ...EMPTY_SESSION_STATE,
          last_mode: "ALGORITHM",
          last_tier: 5,
        },
      ],
    ])
    const layer = Layer.mergeAll(
      SessionStateTest(seed),
      RuntimeConfigTest({
        workerMandatoryMode: "strict",
        workerIdOverride: Option.some("worker-123"),
      }),
    )

    const d = await Effect.runPromise(
      handlePreToolUse(
        payload("Write", { file_path: "/repo/src/new.ts", content: "x" }),
      ).pipe(Effect.provide(layer)),
    )

    expect(d).toEqual({})
  })

  test("Task launch is rewritten with a bounded worker contract", async () => {
    const d = await run("Task", {
      description: "inspect auth",
      prompt: "Find where auth is implemented.",
      subagent_type: "Explore",
    })
    expectDecision(d, "allow")
    const out = d as {
      hookSpecificOutput: {
        updatedInput?: { prompt?: string; subagent_type?: string }
      }
    }
    expect(out.hookSpecificOutput.updatedInput?.prompt).toContain(
      WORKER_CONTRACT_MARKER,
    )
    expect(out.hookSpecificOutput.updatedInput?.prompt).toContain(
      "read-only investigator",
    )
  })

  test("Task launch with a current worker contract is not rewritten twice", async () => {
    const d = await run("Task", {
      description: "inspect auth",
      prompt: appendWorkerContract("Find auth.", "Explore"),
      subagent_type: "Explore",
    })
    expect(d).toEqual({})
  })

  test("Task launch with a stale worker contract is refreshed before launch", async () => {
    const d = await run("Task", {
      description: "inspect auth",
      prompt: [
        "Find auth.",
        "",
        WORKER_CONTRACT_MARKER,
        "Contract version: 0",
        "Contract hash: stale-hash",
        "contract already here",
        "</claude-hooks-worker-contract>",
      ].join("\n"),
      subagent_type: "Explore",
    })

    expectDecision(d, "allow")
    const out = d as {
      hookSpecificOutput: {
        updatedInput?: { prompt?: string }
      }
    }
    const updatedPrompt = out.hookSpecificOutput.updatedInput?.prompt ?? ""
    expect(updatedPrompt).toContain(`Contract version: ${CURRENT_WORKER_CONTRACT_VERSION}`)
    expect(updatedPrompt).toContain(`Contract hash: ${CURRENT_WORKER_CONTRACT_HASH}`)
    expect(updatedPrompt).not.toContain("stale-hash")
    expect(updatedPrompt.match(new RegExp(WORKER_CONTRACT_MARKER, "g"))?.length).toBe(1)
  })

  test("malformed Task launch asks instead of silently dropping worker scope", async () => {
    const d = await run("Task", { description: "missing prompt" })
    expectDecision(d, "ask")
  })
})
