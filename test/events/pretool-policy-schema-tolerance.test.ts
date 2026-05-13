/**
 * Pins the contract that *unrecognized* tool-input shapes never silently
 * bypass write-side path policies. Before this hardening, Read/Edit/Write
 * decode failures returned `passthrough` while Bash decode failures asked.
 * If Claude Code drifts a schema (renames a field, adds a wrapper), the
 * passthrough branch would silently grant access to .env / lockfiles /
 * protected paths because the path-policy reducers never ran.
 *
 * The tests below describe what "decode failed" must produce regardless
 * of which tool is involved, AND prove the happy path is unchanged.
 *
 * Designed from the contract, not from the surface diff: each case is a
 * scenario a future schema change could introduce, and each assertion
 * pins the safety property we don't want to lose.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { handlePreToolUse } from "../../src/events/pretool-policy.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { HookFailureTest } from "../../src/services/hook-failure.ts"
import { SessionStateTest } from "../../src/services/session-state.ts"

interface PreToolDecision {
  hookSpecificOutput?: {
    permissionDecision?: string
    permissionDecisionReason?: string
  }
}

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const run = async (
  toolName: string,
  toolInput: unknown,
): Promise<PreToolDecision> => {
  const payload = decode({
    _tag: "PreToolUse",
    session_id: "schema-test",
    hook_event_name: "PreToolUse",
    cwd: "/tmp",
    tool_name: toolName,
    tool_input: toolInput,
  })
  const out = await Effect.runPromise(
    handlePreToolUse(payload).pipe(Effect.provide(SessionStateTest())),
  )
  return out as PreToolDecision
}

const decisionOf = (d: PreToolDecision): string | undefined =>
  d.hookSpecificOutput?.permissionDecision

describe("schema decode failures must NOT silently fail open", () => {
  // The four write-class entry points share one safety property: a payload
  // whose shape we don't recognize must ask — never passthrough silently.
  // Encode that as a parameterized matrix so a future tool addition only
  // needs one new row, not a new test fixture.
  const malformedCases: ReadonlyArray<{
    readonly tool: string
    readonly input: unknown
    readonly why: string
  }> = [
    {
      tool: "Bash",
      input: { command: 42 },
      why: "command is wrong type — pre-existing baseline behavior",
    },
    {
      tool: "Bash",
      input: {},
      why: "missing required `command` field",
    },
    {
      tool: "Read",
      input: {},
      why: "missing `file_path` — pre-fix this returned passthrough silently",
    },
    {
      tool: "Read",
      input: { file_path: 42 },
      why: "wrong-typed file_path — pre-fix this passed through silently",
    },
    {
      tool: "Edit",
      input: { file_path: "/tmp/x" },
      why: "missing old_string/new_string — none of Edit/Write/MultiEdit decode",
    },
    {
      tool: "Edit",
      input: {},
      why: "empty object matches no schema — was passthrough silently",
    },
    {
      tool: "Write",
      input: { file_path: 7, content: "x" },
      why: "wrong-typed file_path — failed all three schemas",
    },
    {
      tool: "MultiEdit",
      input: { file_path: "/tmp/x", edits: "not an array" },
      why: "edits wrong type — failed MultiEditInput",
    },
  ]

  for (const c of malformedCases) {
    test(`${c.tool} (${c.why}) → ask`, async () => {
      const d = await run(c.tool, c.input)
      expect(decisionOf(d)).toBe("ask")
      // The reason field must explain why we asked — observability matters
      // for debugging schema drift later. Empty/missing reason is itself a
      // bug because it gives operators nothing to grep.
      const reason = d.hookSpecificOutput?.permissionDecisionReason ?? ""
      expect(reason.length).toBeGreaterThan(0)
    })
  }

  // Symmetry: if a future change weakens the Read/Edit/Write side back to
  // silent passthrough, this test catches it by demanding parity with the
  // Bash branch — the doctrine that's been there since M2.
  test("Read decode failure parity with Bash decode failure", async () => {
    const bashOut = await run("Bash", { command: 42 })
    const readOut = await run("Read", { file_path: 42 })
    expect(decisionOf(bashOut)).toBe(decisionOf(readOut))
  })

  test("decode failure diagnostics include the hook-safe fallback decision", async () => {
    const payload = decode({
      _tag: "PreToolUse",
      session_id: "schema-test",
      hook_event_name: "PreToolUse",
      cwd: "/tmp",
      tool_name: "Read",
      tool_input: { file_path: 42 },
    })
    const hookFailures = HookFailureTest()

    const decision = await Effect.runPromise(
      handlePreToolUse(payload).pipe(
        Effect.provide(SessionStateTest()),
        Effect.provide(hookFailures.layer),
      ),
    )

    const record = hookFailures.records()[0]
    if (record === undefined) throw new Error("missing hook failure record")
    expect(decisionOf(decision as PreToolDecision)).toBe("ask")
    expect(record.kind).toBe("payload_decode_failed")
    expect(record.fallbackDecision).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      decision: undefined,
      reason: undefined,
      permissionDecisionReason:
        "Read input did not match expected schema; confirming for safety so secret-path checks aren't silently bypassed.",
    })
  })
})

describe("schema decode SUCCESS leaves the policy pipeline intact", () => {
  // These pin the non-regression: the schema-tolerance hardening must not
  // change any behavior for valid inputs. If it does, secret-path /
  // lockfile / protected-path checks have been broken.

  test("Read with valid .env path still denies (path policies still run)", async () => {
    const d = await run("Read", { file_path: "/Users/x/proj/.env" })
    expect(decisionOf(d)).toBe("deny")
  })

  test("Read with neutral path still allows", async () => {
    const d = await run("Read", { file_path: "/tmp/normal.txt" })
    // Anything other than ask/deny is acceptable for a neutral read; what
    // matters is we did NOT regress to ask on a perfectly-shaped payload.
    expect(decisionOf(d)).not.toBe("ask")
  })

  test("Write to a lockfile still asks (path-policy reducer fired)", async () => {
    // The lockfile policy returns `ask`, not `deny` — the assertion
    // worth pinning is "the policy reducer ran and returned ask",
    // not the specific verdict spelling. If the reducer were silently
    // skipped (the bug this PR addresses), we'd see allow/passthrough.
    const d = await run("Write", { file_path: "/proj/package-lock.json", content: "{}" })
    expect(decisionOf(d)).toBe("ask")
  })

  test("Edit with valid input shape does NOT ask", async () => {
    const d = await run("Edit", {
      file_path: "/tmp/normal.ts",
      old_string: "a",
      new_string: "b",
    })
    expect(decisionOf(d)).not.toBe("ask")
  })

  test("MultiEdit with valid input shape does NOT ask", async () => {
    const d = await run("MultiEdit", {
      file_path: "/tmp/normal.ts",
      edits: [{ old_string: "a", new_string: "b" }],
    })
    expect(decisionOf(d)).not.toBe("ask")
  })
})
