/**
 * PR 2 — deepened engagement-gate tests.
 *
 * Pin a NEW signature where the gate owns accepted-path construction
 * internally given (currentCwd, sessionRoot, record, toolName, toolInput).
 * The old shallow signature (precomputed acceptedWritePaths etc.) is the
 * caller's problem in the GREEN phase; until then these tests fail.
 *
 * These tests use a temp directory as the session root and exercise disk
 * existence (ISA.md present/absent) so the gate's release-on-disk logic
 * is exercised end-to-end.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { evaluateEngagementGate } from "../../src/policies/engagement-gate.ts"
import { safeResolvePath } from "../../src/services/path-resolution.ts"
import {
  EMPTY_SESSION_STATE,
  type SessionStateRecord,
} from "../../src/services/session-state.ts"

const EXPECTED_REL = ".claude-hooks/work/sess-1/ISA.md"
const EXPECTED_DIR_REL = ".claude-hooks/work/sess-1"

let root: string
let cleanup: () => void

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "chts-pr2-gate-"))
  cleanup = () => fs.rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  cleanup()
})

const engagedRecord = (
  overrides: Partial<SessionStateRecord> = {},
): SessionStateRecord => ({
  ...EMPTY_SESSION_STATE,
  engagement_required: true,
  last_mode: "ALGORITHM",
  last_tier: 3,
  expected_isa_path: EXPECTED_REL,
  expected_isa_path_absolute: safeResolvePath(root, EXPECTED_REL),
  session_root: root,
  ...overrides,
})

describe("evaluateEngagementGate (deepened) — passthrough", () => {
  test("engagement not required → passthrough", () => {
    const v = evaluateEngagementGate({
      currentCwd: root,
      sessionRoot: root,
      record: { ...EMPTY_SESSION_STATE, engagement_required: false },
      toolName: "Write",
      toolInput: { file_path: path.join(root, "src/foo.ts") },
    })
    expect(v.kind).toBe("passthrough")
  })

  test("Write to expected_isa_path_absolute → passthrough", () => {
    const v = evaluateEngagementGate({
      currentCwd: root,
      sessionRoot: root,
      record: engagedRecord(),
      toolName: "Write",
      toolInput: { file_path: path.join(root, EXPECTED_REL) },
    })
    expect(v.kind).toBe("passthrough")
  })

  test("Edit to expected_isa_path_absolute → passthrough", () => {
    const v = evaluateEngagementGate({
      currentCwd: root,
      sessionRoot: root,
      record: engagedRecord(),
      toolName: "Edit",
      toolInput: { file_path: path.join(root, EXPECTED_REL) },
    })
    expect(v.kind).toBe("passthrough")
  })

  test("Edit to <sessionRoot>/ISA.md when project ISA exists → passthrough", () => {
    fs.writeFileSync(path.join(root, "ISA.md"), "# project isa\n")
    const v = evaluateEngagementGate({
      currentCwd: root,
      sessionRoot: root,
      record: engagedRecord(),
      toolName: "Edit",
      toolInput: { file_path: path.join(root, "ISA.md") },
    })
    expect(v.kind).toBe("passthrough")
  })

  test("Bash mkdir -p <expectedDir absolute> → passthrough", () => {
    const v = evaluateEngagementGate({
      currentCwd: root,
      sessionRoot: root,
      record: engagedRecord(),
      toolName: "Bash",
      toolInput: {
        command: `mkdir -p ${safeResolvePath(root, EXPECTED_DIR_REL)}`,
      },
    })
    expect(v.kind).toBe("passthrough")
  })

  test("Bash mkdir -p <expectedDir relative> when cwd === sessionRoot → passthrough", () => {
    const v = evaluateEngagementGate({
      currentCwd: root,
      sessionRoot: root,
      record: engagedRecord(),
      toolName: "Bash",
      toolInput: { command: `mkdir -p ${EXPECTED_DIR_REL}` },
    })
    expect(v.kind).toBe("passthrough")
  })

  test("Bash pwd before ISA exists → passthrough", () => {
    const v = evaluateEngagementGate({
      currentCwd: root,
      sessionRoot: root,
      record: engagedRecord(),
      toolName: "Bash",
      toolInput: { command: "pwd" },
    })
    expect(v.kind).toBe("passthrough")
  })

  test("Bash rg before ISA exists → passthrough", () => {
    const v = evaluateEngagementGate({
      currentCwd: root,
      sessionRoot: root,
      record: engagedRecord(),
      toolName: "Bash",
      toolInput: {
        command: "rg -n \"runGitApply|applyWorkerPatch\" src/services/worker-integration.ts",
      },
    })
    expect(v.kind).toBe("passthrough")
  })

  test("Bash workers list --json before ISA exists → passthrough", () => {
    const v = evaluateEngagementGate({
      currentCwd: root,
      sessionRoot: root,
      record: engagedRecord(),
      toolName: "Bash",
      toolInput: { command: "./bin/claude-hooks-workers list --json" },
    })
    expect(v.kind).toBe("passthrough")
  })

  test("Read during engagement → passthrough", () => {
    const v = evaluateEngagementGate({
      currentCwd: root,
      sessionRoot: root,
      record: engagedRecord(),
      toolName: "Read",
      toolInput: { file_path: path.join(root, "src/anything.ts") },
    })
    expect(v.kind).toBe("passthrough")
  })

  test("symlinked sessionRoot: write through symlink-resolved expected path → passthrough", () => {
    // Real session root under root/real, symlinked at root/link. Engagement
    // record stores the symlinked absolute path; tool input arrives through
    // the real path. The gate must accept via realpath normalization.
    const realRoot = path.join(root, "real")
    fs.mkdirSync(realRoot, { recursive: true })
    const linkRoot = path.join(root, "link")
    fs.symlinkSync(realRoot, linkRoot, "dir")
    const v = evaluateEngagementGate({
      currentCwd: realRoot,
      sessionRoot: linkRoot,
      record: engagedRecord({
        session_root: linkRoot,
        expected_isa_path_absolute: safeResolvePath(linkRoot, EXPECTED_REL),
      }),
      toolName: "Write",
      toolInput: { file_path: path.join(realRoot, EXPECTED_REL) },
    })
    expect(v.kind).toBe("passthrough")
  })
})

describe("evaluateEngagementGate (deepened) — deny", () => {
  test("Write to unrelated path before ISA exists → deny", () => {
    const v = evaluateEngagementGate({
      currentCwd: root,
      sessionRoot: root,
      record: engagedRecord(),
      toolName: "Write",
      toolInput: { file_path: path.join(root, "src/foo.ts") },
    })
    expect(v.kind).toBe("deny")
  })

  test("Edit to <sessionRoot>/ISA.md when project ISA does NOT exist → deny", () => {
    const v = evaluateEngagementGate({
      currentCwd: root,
      sessionRoot: root,
      record: engagedRecord(),
      toolName: "Edit",
      toolInput: { file_path: path.join(root, "ISA.md") },
    })
    expect(v.kind).toBe("deny")
  })

  test("Bash mkdir -p <relative> when cwd !== sessionRoot → deny", () => {
    const drift = fs.mkdtempSync(path.join(os.tmpdir(), "chts-pr2-drift-"))
    try {
      const v = evaluateEngagementGate({
        currentCwd: drift,
        sessionRoot: root,
        record: engagedRecord(),
        toolName: "Bash",
        toolInput: { command: `mkdir -p ${EXPECTED_DIR_REL}` },
      })
      expect(v.kind).toBe("deny")
    } finally {
      fs.rmSync(drift, { recursive: true, force: true })
    }
  })

  // P2a — deny reason names the absolute ISA path so the model can write
  // unambiguously even from a drifted cwd. The relative form alone is
  // ambiguous after a Bash `cd`.
  test("deny reason includes the absolute expected-ISA path", () => {
    const drift = fs.mkdtempSync(path.join(os.tmpdir(), "chts-pr2-drift-msg-"))
    try {
      const v = evaluateEngagementGate({
        currentCwd: drift,
        sessionRoot: root,
        record: engagedRecord(),
        toolName: "Write",
        toolInput: { file_path: path.join(drift, "src/foo.ts") },
      })
      expect(v.kind).toBe("deny")
      if (v.kind === "deny") {
        const expectedAbs = safeResolvePath(root, EXPECTED_REL)
        expect(expectedAbs).not.toBeNull()
        expect(v.reason).toContain(EXPECTED_REL)
        expect(v.reason).toContain(expectedAbs as string)
      }
    } finally {
      fs.rmSync(drift, { recursive: true, force: true })
    }
  })
})
