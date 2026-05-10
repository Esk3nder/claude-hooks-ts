/**
 * Pure engagement-gate policy tests. The Effect-side wrapper (in
 * `events/pretool-policy.ts`) is covered by pretool-engagement.test.ts —
 * here we pin the decision matrix directly. The wrapper is responsible
 * for path normalization; this test passes already-normalized strings.
 */
import { describe, expect, test } from "bun:test"
import { evaluateEngagementGate } from "../../src/policies/engagement-gate.ts"

const EXPECTED_ABS = "/repo/.claude-hooks/work/sess-1/ISA.md"
const EXPECTED_DIR = "/repo/.claude-hooks/work/sess-1"
const PROJECT_ISA_ABS = "/repo/ISA.md"

const baseCtx = {
  engagement_required: true as const,
  anyAcceptedIsaExists: false,
  acceptedWritePaths: [EXPECTED_ABS],
  acceptedEditPaths: [EXPECTED_ABS],
  acceptedMkdirDirs: [EXPECTED_DIR],
  displayIsaPath: ".claude-hooks/work/sess-1/ISA.md",
  displayMkdirDir: ".claude-hooks/work/sess-1",
  resolvedToolFilePath: null as string | null,
}

describe("evaluateEngagementGate — passthrough cases", () => {
  test("engagement_required=false → passthrough", () => {
    const v = evaluateEngagementGate({
      ...baseCtx,
      engagement_required: false,
      toolName: "Write",
      toolInput: { file_path: "/repo/src/foo.ts" },
      resolvedToolFilePath: "/repo/src/foo.ts",
    })
    expect(v.kind).toBe("passthrough")
  })

  test("anyAcceptedIsaExists=true → passthrough on non-ISA write", () => {
    const v = evaluateEngagementGate({
      ...baseCtx,
      anyAcceptedIsaExists: true,
      toolName: "Write",
      toolInput: { file_path: "/repo/src/foo.ts" },
      resolvedToolFilePath: "/repo/src/foo.ts",
    })
    expect(v.kind).toBe("passthrough")
  })

  test("acceptedWritePaths=[] → fail-open passthrough", () => {
    const v = evaluateEngagementGate({
      ...baseCtx,
      acceptedWritePaths: [],
      acceptedEditPaths: [],
      toolName: "Write",
      toolInput: { file_path: "/repo/src/foo.ts" },
      resolvedToolFilePath: "/repo/src/foo.ts",
    })
    expect(v.kind).toBe("passthrough")
  })

  test.each(["Read", "Glob", "Grep", "LS", "TodoWrite", "Task", "Skill"])(
    "%s during engagement → passthrough",
    (toolName) => {
      const v = evaluateEngagementGate({
        ...baseCtx,
        toolName,
        toolInput: {},
      })
      expect(v.kind).toBe("passthrough")
    },
  )

  test("Write to expected_isa_path → passthrough", () => {
    const v = evaluateEngagementGate({
      ...baseCtx,
      toolName: "Write",
      toolInput: { file_path: EXPECTED_ABS },
      resolvedToolFilePath: EXPECTED_ABS,
    })
    expect(v.kind).toBe("passthrough")
  })

  test("Edit to expected_isa_path → passthrough", () => {
    const v = evaluateEngagementGate({
      ...baseCtx,
      toolName: "Edit",
      toolInput: { file_path: EXPECTED_ABS },
      resolvedToolFilePath: EXPECTED_ABS,
    })
    expect(v.kind).toBe("passthrough")
  })

  test("Edit to existing project ISA → passthrough (Stop-gate alignment)", () => {
    const v = evaluateEngagementGate({
      ...baseCtx,
      acceptedEditPaths: [EXPECTED_ABS, PROJECT_ISA_ABS],
      toolName: "Edit",
      toolInput: { file_path: PROJECT_ISA_ABS },
      resolvedToolFilePath: PROJECT_ISA_ABS,
    })
    expect(v.kind).toBe("passthrough")
  })

  test("MultiEdit to existing project ISA → passthrough", () => {
    const v = evaluateEngagementGate({
      ...baseCtx,
      acceptedEditPaths: [EXPECTED_ABS, PROJECT_ISA_ABS],
      toolName: "MultiEdit",
      toolInput: { file_path: PROJECT_ISA_ABS },
      resolvedToolFilePath: PROJECT_ISA_ABS,
    })
    expect(v.kind).toBe("passthrough")
  })

  test("Bash mkdir -p <expected_dir> → passthrough", () => {
    const v = evaluateEngagementGate({
      ...baseCtx,
      toolName: "Bash",
      toolInput: { command: `mkdir -p ${EXPECTED_DIR}` },
    })
    expect(v.kind).toBe("passthrough")
  })

  test("Bash bare 'mkdir' → passthrough", () => {
    const v = evaluateEngagementGate({
      ...baseCtx,
      toolName: "Bash",
      toolInput: { command: "mkdir" },
    })
    expect(v.kind).toBe("passthrough")
  })

  test("Unknown tool name (e.g. MCP tool) → passthrough", () => {
    const v = evaluateEngagementGate({
      ...baseCtx,
      toolName: "mcp__weather__get_forecast",
      toolInput: {},
    })
    expect(v.kind).toBe("passthrough")
  })
})

describe("evaluateEngagementGate — deny cases", () => {
  test("Write to non-ISA file → deny with directive", () => {
    const v = evaluateEngagementGate({
      ...baseCtx,
      toolName: "Write",
      toolInput: { file_path: "/repo/src/foo.ts" },
      resolvedToolFilePath: "/repo/src/foo.ts",
    })
    expect(v.kind).toBe("deny")
    if (v.kind === "deny") {
      expect(v.reason).toContain("ALGORITHM engagement is required")
      expect(v.reason).toContain(".claude-hooks/work/sess-1/ISA.md")
      expect(v.reason).toContain("CLAUDE_HOOKS_DISABLE_ISA_PRETOOL_GATE")
    }
  })

  test("Write to <repo>/ISA.md (project ISA) → deny even when project ISA exists", () => {
    // Write is intentionally narrower than Edit: even if a project ISA
    // already exists, Write to it from scratch is denied (would replace
    // an existing ISA from outside the directive's deterministic path).
    const v = evaluateEngagementGate({
      ...baseCtx,
      acceptedEditPaths: [EXPECTED_ABS, PROJECT_ISA_ABS],
      toolName: "Write",
      toolInput: { file_path: PROJECT_ISA_ABS },
      resolvedToolFilePath: PROJECT_ISA_ABS,
    })
    expect(v.kind).toBe("deny")
  })

  test("Edit to <repo>/ISA.md when project ISA does NOT exist → deny", () => {
    const v = evaluateEngagementGate({
      ...baseCtx,
      // project ISA absent → not in acceptedEditPaths
      acceptedEditPaths: [EXPECTED_ABS],
      toolName: "Edit",
      toolInput: { file_path: PROJECT_ISA_ABS },
      resolvedToolFilePath: PROJECT_ISA_ABS,
    })
    expect(v.kind).toBe("deny")
  })

  test("Edit to non-ISA file → deny", () => {
    const v = evaluateEngagementGate({
      ...baseCtx,
      toolName: "Edit",
      toolInput: { file_path: "/repo/README.md" },
      resolvedToolFilePath: "/repo/README.md",
    })
    expect(v.kind).toBe("deny")
  })

  test("MultiEdit to non-ISA file → deny", () => {
    const v = evaluateEngagementGate({
      ...baseCtx,
      toolName: "MultiEdit",
      toolInput: { file_path: "/repo/src/x.ts" },
      resolvedToolFilePath: "/repo/src/x.ts",
    })
    expect(v.kind).toBe("deny")
  })

  test("Bash non-mkdir command → deny", () => {
    const v = evaluateEngagementGate({
      ...baseCtx,
      toolName: "Bash",
      toolInput: { command: "bun test" },
    })
    expect(v.kind).toBe("deny")
  })

  test("Bash mkdir of unrelated dir → deny", () => {
    const v = evaluateEngagementGate({
      ...baseCtx,
      toolName: "Bash",
      toolInput: { command: "mkdir /tmp/something-else" },
    })
    expect(v.kind).toBe("deny")
  })

  test("Bash 'mkdirX' → deny (prefix-match guard)", () => {
    const v = evaluateEngagementGate({
      ...baseCtx,
      toolName: "Bash",
      toolInput: { command: "mkdirX" },
    })
    expect(v.kind).toBe("deny")
  })

  test("Bash 'sudo mkdir <dir>' → deny", () => {
    const v = evaluateEngagementGate({
      ...baseCtx,
      toolName: "Bash",
      toolInput: { command: `sudo mkdir ${EXPECTED_DIR}` },
    })
    expect(v.kind).toBe("deny")
  })

  test("Bash 'mkdir <dir> && rm -rf /' → deny (chained command)", () => {
    const v = evaluateEngagementGate({
      ...baseCtx,
      toolName: "Bash",
      toolInput: { command: `mkdir ${EXPECTED_DIR} && rm -rf /` },
    })
    expect(v.kind).toBe("deny")
  })

  test("Write with malformed input (no file_path) → deny", () => {
    const v = evaluateEngagementGate({
      ...baseCtx,
      toolName: "Write",
      toolInput: { contents: "x" },
      resolvedToolFilePath: null,
    })
    expect(v.kind).toBe("deny")
  })
})
