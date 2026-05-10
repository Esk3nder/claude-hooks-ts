/**
 * End-to-end pretool tests for the engagement gate. Verifies the wiring
 * between SessionState (engagement_required + expected_isa_path) and the
 * actual permissionDecision returned by handlePreToolUse.
 *
 * Disk is the source of truth for gate release: the PreToolUse engagement
 * gate releases when the file at `expected_isa_path` exists, regardless
 * of any other ISAs in the project.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { handlePreToolUse } from "../../src/events/pretool-policy.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import {
  SessionStateTest,
  EMPTY_SESSION_STATE,
  type SessionStateRecord,
} from "../../src/services/session-state.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const EXPECTED_ISA_REL = ".claude-hooks/state/work/eng-1/ISA.md"
const EXPECTED_DIR_REL = ".claude-hooks/state/work/eng-1"

const stage = (): { root: string; cleanup: () => void } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chts-engage-pre-"))
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

const ENGAGED_STATE: Partial<SessionStateRecord> = {
  engagement_required: true,
  last_mode: "ALGORITHM",
  last_tier: 3,
  expected_isa_path: EXPECTED_ISA_REL,
}

const runPretool = async (
  cwd: string,
  toolName: string,
  toolInput: unknown,
  state: Partial<SessionStateRecord>,
): Promise<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }> => {
  const sid = "eng-1"
  const seed = new Map([[sid, { ...EMPTY_SESSION_STATE, ...state }]])
  const payload = decode({
    _tag: "PreToolUse",
    session_id: sid,
    hook_event_name: "PreToolUse",
    cwd,
    tool_name: toolName,
    tool_input: toolInput,
  })
  const out = await Effect.runPromise(
    handlePreToolUse(payload).pipe(Effect.provide(SessionStateTest(seed))),
  )
  return out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }
}

describe("PreToolUse engagement gate — wiring", () => {
  test("engagement_required + no ISA + Write to non-ISA → deny with engagement reason", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runPretool(
        root,
        "Write",
        { file_path: path.join(root, "src", "foo.ts"), content: "x" },
        ENGAGED_STATE,
      )
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny")
      expect(out.hookSpecificOutput?.permissionDecisionReason ?? "").toContain(
        "ALGORITHM engagement is required",
      )
    } finally {
      cleanup()
    }
  })

  test("engagement_required + no ISA + Write to expected ISA path → allowed", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runPretool(
        root,
        "Write",
        {
          file_path: path.join(root, EXPECTED_ISA_REL),
          content: "---\n---\n",
        },
        ENGAGED_STATE,
      )
      expect(out.hookSpecificOutput?.permissionDecision).not.toBe("deny")
    } finally {
      cleanup()
    }
  })

  test("Write to <repo>/ISA.md when project ISA does NOT exist → deny", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runPretool(
        root,
        "Write",
        { file_path: path.join(root, "ISA.md"), content: "---\n---\n" },
        ENGAGED_STATE,
      )
      // No existing project ISA + Write would create one at a path the
      // directive did not promise. Deny.
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny")
    } finally {
      cleanup()
    }
  })

  test("Edit on existing <repo>/ISA.md while engagement_required → ALLOWED", async () => {
    const { root, cleanup } = stage()
    try {
      // Project ISA exists already.
      fs.writeFileSync(
        path.join(root, "ISA.md"),
        "---\neffort: advanced\nphase: observe\n---\n\n## Goal\nx\n",
        "utf-8",
      )
      const out = await runPretool(
        root,
        "Edit",
        {
          file_path: path.join(root, "ISA.md"),
          old_string: "x",
          new_string: "y",
        },
        ENGAGED_STATE,
      )
      // Engagement gate aligned with Stop: existing project ISA can be
      // updated. (Once the project ISA exists, the gate also releases on
      // the next call — see the inert test below.)
      expect(out.hookSpecificOutput?.permissionDecision).not.toBe("deny")
    } finally {
      cleanup()
    }
  })

  test("engagement_required + ISA exists at expected path on disk → gate inert", async () => {
    const { root, cleanup } = stage()
    try {
      // Create the ISA at the deterministic path.
      const isaAbs = path.join(root, EXPECTED_ISA_REL)
      fs.mkdirSync(path.dirname(isaAbs), { recursive: true })
      fs.writeFileSync(
        isaAbs,
        "---\neffort: advanced\nphase: observe\n---\n\n## Goal\nx\n\n## Criteria\n- [ ] ISC-1\n",
        "utf-8",
      )
      const out = await runPretool(
        root,
        "Write",
        { file_path: path.join(root, "src", "foo.ts"), content: "x" },
        ENGAGED_STATE,
      )
      // Engagement gate doesn't fire (expected ISA exists). Default
      // policy passes the write through.
      expect(out.hookSpecificOutput?.permissionDecision).not.toBe("deny")
    } finally {
      cleanup()
    }
  })

  test("project ISA exists at <repo>/ISA.md → gate releases (Stop alignment)", async () => {
    const { root, cleanup } = stage()
    try {
      // Project ISA exists; per the alignment fix, that satisfies
      // engagement and releases the gate for non-ISA writes.
      fs.writeFileSync(
        path.join(root, "ISA.md"),
        "---\neffort: advanced\nphase: observe\n---\n\n## Goal\nx\n",
        "utf-8",
      )
      const out = await runPretool(
        root,
        "Write",
        { file_path: path.join(root, "src", "foo.ts"), content: "x" },
        ENGAGED_STATE,
      )
      expect(out.hookSpecificOutput?.permissionDecision).not.toBe("deny")
    } finally {
      cleanup()
    }
  })

  test("engagement_required=false → gate inert; existing policies still apply", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runPretool(
        root,
        "Bash",
        { command: "rm -rf /" },
        { engagement_required: false },
      )
      // Engagement gate inert; the destructive-command policy fires.
      expect(["deny", "ask"]).toContain(
        out.hookSpecificOutput?.permissionDecision ?? "",
      )
    } finally {
      cleanup()
    }
  })

  test("engagement_required + Bash mkdir of expected ISA dir → allowed", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runPretool(
        root,
        "Bash",
        { command: `mkdir -p ${EXPECTED_DIR_REL}` },
        ENGAGED_STATE,
      )
      expect(out.hookSpecificOutput?.permissionDecision).not.toBe("deny")
    } finally {
      cleanup()
    }
  })

  test("engagement_required + Bash mkdir of UNRELATED dir → denied", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runPretool(
        root,
        "Bash",
        { command: "mkdir /tmp/scratch" },
        ENGAGED_STATE,
      )
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny")
    } finally {
      cleanup()
    }
  })

  test("engagement_required + Read on a project file → allowed (inspection always OK)", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runPretool(
        root,
        "Read",
        { file_path: path.join(root, "src", "foo.ts") },
        ENGAGED_STATE,
      )
      expect(out.hookSpecificOutput?.permissionDecision).not.toBe("deny")
    } finally {
      cleanup()
    }
  })
})

describe("PreToolUse engagement gate — path normalization & traversal", () => {
  test("traversal: .../sess-1/../other/ISA.md → deny (resolves outside expected)", async () => {
    const { root, cleanup } = stage()
    try {
      const sneaky = path.join(
        root,
        ".claude-hooks",
        "state",
        "work",
        "eng-1",
        "..",
        "other",
        "ISA.md",
      )
      const out = await runPretool(root, "Write", { file_path: sneaky, content: "x" }, ENGAGED_STATE)
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny")
    } finally {
      cleanup()
    }
  })

  test("traversal: relative path with .. resolved to expected → ALLOWED", async () => {
    const { root, cleanup } = stage()
    try {
      // Build an equivalent relative path that resolves to the expected
      // ISA via `..`.
      fs.mkdirSync(path.join(root, "sibling"), { recursive: true })
      const equivalent = path.join(
        root,
        "sibling",
        "..",
        ".claude-hooks",
        "state",
        "work",
        "eng-1",
        "ISA.md",
      )
      const out = await runPretool(
        root,
        "Write",
        { file_path: equivalent, content: "---\n---\n" },
        ENGAGED_STATE,
      )
      expect(out.hookSpecificOutput?.permissionDecision).not.toBe("deny")
    } finally {
      cleanup()
    }
  })

  test("symlink: parent dir is a symlink resolving inside cwd → ALLOWED", async () => {
    const { root, cleanup } = stage()
    try {
      // Real expected path on disk.
      const realDir = path.join(root, ".claude-hooks", "state", "work", "eng-1")
      fs.mkdirSync(realDir, { recursive: true })
      // Symlink under a different prefix that points to realDir.
      const linkDir = path.join(root, "linked-eng-1")
      fs.symlinkSync(realDir, linkDir, "dir")
      const symlinked = path.join(linkDir, "ISA.md")
      const out = await runPretool(
        root,
        "Write",
        { file_path: symlinked, content: "---\n---\n" },
        ENGAGED_STATE,
      )
      // Symlink resolves to the same realpath as the expected ISA → allow.
      expect(out.hookSpecificOutput?.permissionDecision).not.toBe("deny")
    } finally {
      cleanup()
    }
  })

  test("symlink-attack: input via symlink resolving OUTSIDE expected path → deny", async () => {
    // Setup: expected ISA dir is a real, unsymlinked directory under cwd.
    // A separate symlink elsewhere in cwd points to a tmpdir outside cwd.
    // The model attempts to Write via the symlink; after realpath, the
    // resolved path does NOT match the expected ISA → deny.
    const { root, cleanup } = stage()
    const escape = fs.mkdtempSync(path.join(os.tmpdir(), "chts-engage-escape-"))
    try {
      // Real expected dir (unsymlinked).
      const realExpectedDir = path.join(
        root,
        ".claude-hooks",
        "state",
        "work",
        "eng-1",
      )
      fs.mkdirSync(realExpectedDir, { recursive: true })

      // Symlink trickery: <root>/sneaky → /tmp/escape.
      const sneakyLink = path.join(root, "sneaky")
      fs.symlinkSync(escape, sneakyLink, "dir")
      const attackerPath = path.join(sneakyLink, "ISA.md")

      const out = await runPretool(
        root,
        "Write",
        { file_path: attackerPath, content: "---\n---\n" },
        ENGAGED_STATE,
      )
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny")
      expect(
        out.hookSpecificOutput?.permissionDecisionReason ?? "",
      ).toContain("ALGORITHM engagement is required")
    } finally {
      cleanup()
      fs.rmSync(escape, { recursive: true, force: true })
    }
  })
})

describe("PreToolUse engagement gate — escape hatch", () => {
  const ENV_KEY = "CLAUDE_HOOKS_DISABLE_ISA_PRETOOL_GATE"
  let prior: string | undefined
  beforeEach(() => {
    prior = process.env[ENV_KEY]
  })
  afterEach(() => {
    if (prior === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = prior
  })

  test(`${ENV_KEY}=1 bypasses the gate even when engagement_required && no ISA`, async () => {
    process.env[ENV_KEY] = "1"
    const { root, cleanup } = stage()
    try {
      const out = await runPretool(
        root,
        "Write",
        { file_path: path.join(root, "src", "foo.ts"), content: "x" },
        ENGAGED_STATE,
      )
      // Bypassed — the engagement gate doesn't fire. Default policy is
      // permissive for this path.
      expect(out.hookSpecificOutput?.permissionDecision).not.toBe("deny")
    } finally {
      cleanup()
    }
  })

  test(`${ENV_KEY}=0 (or unset) leaves the gate enforcing`, async () => {
    process.env[ENV_KEY] = "0"
    const { root, cleanup } = stage()
    try {
      const out = await runPretool(
        root,
        "Write",
        { file_path: path.join(root, "src", "foo.ts"), content: "x" },
        ENGAGED_STATE,
      )
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny")
    } finally {
      cleanup()
    }
  })
})
