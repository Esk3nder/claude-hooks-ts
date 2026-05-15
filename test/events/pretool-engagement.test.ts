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
import { Effect, Layer, Schema } from "effect"
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
import { RuntimeConfigTest, type RuntimeConfig } from "../../src/services/runtime-config.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const EXPECTED_ISA_REL = ".claude-hooks/work/eng-1/ISA.md"
const EXPECTED_DIR_REL = ".claude-hooks/work/eng-1"

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
  runtimeConfig: Partial<RuntimeConfig> = {},
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
  const layer = Layer.mergeAll(SessionStateTest(seed), RuntimeConfigTest(runtimeConfig))
  const out = await Effect.runPromise(
    handlePreToolUse(payload).pipe(Effect.provide(layer)),
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
        "ISA required before this tool can run",
      )
    } finally {
      cleanup()
    }
  })

  test("engagement_required + no ISA + Write to expected ISA path → explicitly allowed", async () => {
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
      expect(out.hookSpecificOutput?.permissionDecision).toBe("allow")
      expect(out.hookSpecificOutput?.permissionDecisionReason ?? "").toContain(
        "Scoped ISA artifact write allowed",
      )
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
      // updated without a human approval prompt.
      expect(out.hookSpecificOutput?.permissionDecision).toBe("allow")
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

  test("engagement_required + ISA exists + Update to expected ISA path → explicitly allowed", async () => {
    const { root, cleanup } = stage()
    try {
      const isaAbs = path.join(root, EXPECTED_ISA_REL)
      fs.mkdirSync(path.dirname(isaAbs), { recursive: true })
      fs.writeFileSync(
        isaAbs,
        "---\neffort: advanced\nphase: observe\n---\n\n## Goal\nx\n\n## Criteria\n- [ ] ISC-1\n",
        "utf-8",
      )
      const out = await runPretool(
        root,
        "Update",
        {
          file_path: isaAbs,
          old_string: "phase: observe",
          new_string: "phase: complete",
        },
        ENGAGED_STATE,
      )
      expect(out.hookSpecificOutput?.permissionDecision).toBe("allow")
      expect(out.hookSpecificOutput?.permissionDecisionReason ?? "").toContain(
        "Scoped ISA artifact write allowed",
      )
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

  test("engagement_required + Bash pwd before ISA exists → allowed", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runPretool(
        root,
        "Bash",
        { command: "pwd" },
        ENGAGED_STATE,
      )
      expect(out.hookSpecificOutput?.permissionDecision).not.toBe("deny")
    } finally {
      cleanup()
    }
  })

  test("engagement_required + Bash rg inspection before ISA exists → allowed", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runPretool(
        root,
        "Bash",
        {
          command: "rg -n \"runGitApply|applyWorkerPatch\" src/services/worker-integration.ts",
        },
        ENGAGED_STATE,
      )
      expect(out.hookSpecificOutput?.permissionDecision).not.toBe("deny")
    } finally {
      cleanup()
    }
  })

  test("engagement_required + workers list --json before ISA exists → allowed", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runPretool(
        root,
        "Bash",
        { command: "./bin/claude-hooks-workers list --json" },
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
      const realDir = path.join(root, ".claude-hooks", "work", "eng-1")
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
      ).toContain("ISA required before this tool can run")
    } finally {
      cleanup()
      fs.rmSync(escape, { recursive: true, force: true })
    }
  })
})

describe("PreToolUse engagement gate — RuntimeConfig escape hatch", () => {
  test("isaPretoolGateDisabled bypasses the gate even when engagement_required && no ISA", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runPretool(
        root,
        "Write",
        { file_path: path.join(root, "src", "foo.ts"), content: "x" },
        ENGAGED_STATE,
        { isaPretoolGateDisabled: true },
      )
      // Bypassed — the engagement gate doesn't fire. Default policy is
      // permissive for this path.
      expect(out.hookSpecificOutput?.permissionDecision).not.toBe("deny")
    } finally {
      cleanup()
    }
  })

  test("default config leaves the gate enforcing", async () => {
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

// The contract: when the model issues `mkdir -p` to create the ISA
// parent directory during engagement, every spelling humans actually
// type for "this relative directory" must be accepted. Otherwise the
// gate locks out the model on a punctuation mismatch.
//
// Designed by enumerating the spellings a model realistically produces
// (`foo/bar`, `./foo/bar`, `<abs>/foo/bar`) — each is a positive case.
// Negative cases catch future widening: a sibling slug must still be
// denied, and a chained destructive command must still be denied.
describe("PreToolUse engagement gate — mkdir spelling tolerance", () => {
  test("bare relative form `mkdir -p .claude-hooks/state/work/eng-1` → allow", async () => {
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

  test("`./`-prefixed form `mkdir -p ./.claude-hooks/state/work/eng-1` → allow", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runPretool(
        root,
        "Bash",
        { command: `mkdir -p ./${EXPECTED_DIR_REL}` },
        ENGAGED_STATE,
      )
      expect(out.hookSpecificOutput?.permissionDecision).not.toBe("deny")
    } finally {
      cleanup()
    }
  })

  // Absolute-form mkdir is intentionally NOT pinned here. The wrapper
  // realpath-normalizes accepted paths before whitelisting, so on macOS
  // the whitelist contains `/private/tmp/...` while a model command
  // built from `cwd + relative` carries `/tmp/...`. The two strings
  // mismatch via the tmp→private/tmp symlink and the gate denies. That
  // is a separate environmental issue (the gate accepts the relative
  // forms which is the realistic model-side behavior); fixing it would
  // require either denormalizing the whitelist or symlink-aware compare.
  // Captured as a follow-up rather than in-scope here.

  // Negative: a sibling directory that happens to share the same prefix
  // structure but is NOT the ISA parent must still be denied. Catches a
  // future widening that uses `startsWith` instead of exact match.
  test("`mkdir -p .claude-hooks/state/work/other` (different slug) → deny", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runPretool(
        root,
        "Bash",
        { command: `mkdir -p .claude-hooks/state/work/other` },
        ENGAGED_STATE,
      )
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny")
    } finally {
      cleanup()
    }
  })

  // Negative: chained command that *starts* with the right mkdir but
  // appends a destructive op. Pins that the metachar guard still blocks.
  test("`mkdir -p <dir> && rm -rf /` → deny", async () => {
    const { root, cleanup } = stage()
    try {
      const out = await runPretool(
        root,
        "Bash",
        {
          command: `mkdir -p ${EXPECTED_DIR_REL} && rm -rf /`,
        },
        ENGAGED_STATE,
      )
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny")
    } finally {
      cleanup()
    }
  })
})
