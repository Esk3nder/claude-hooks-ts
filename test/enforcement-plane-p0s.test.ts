/**
 * Regression pins for the three enforcement-plane P0s confirmed by the
 * 2026-05-20 Opus diligence:
 *
 *   #2 — `Update` / `NotebookEdit` were skipping write-path policies
 *   #3 — Unknown / MCP tools were passthrough during pre-ISA engagement
 *   #6 — Bash heredoc writes were bypassing worker-mandatory strict
 *
 * Each test is structured to FAIL on `main` pre-fix and PASS after.
 * They live in one file because they share the diligence framing —
 * adding a fourth bypass would land next to them.
 */

import { describe, expect, test } from "bun:test"
import { evaluateEngagementGateShallow } from "../src/policies/engagement-gate.ts"
import { evaluateWorkerMandatoryGate } from "../src/policies/worker-mandatory.ts"
import { evaluateSecretPath } from "../src/policies/secret-paths.ts"
import { mutablePathFromInput } from "../src/policies/write-class.ts"

describe("Enforcement P0 #2 — Update / NotebookEdit through write-path policies", () => {
  // The fix routes Update / NotebookEdit through the same reducer as
  // Edit/Write/MultiEdit in pretool-policy.ts. We exercise the chain
  // by demonstrating that (a) mutablePathFromInput extracts the path
  // correctly for both shapes and (b) the underlying policy reducer
  // (here: secret-paths) returns deny for a known-secret path.

  test("Update with file_path on .env: path extracted and secret-paths denies", () => {
    const updateInput = { file_path: "/repo/.env", edits: [] }
    const path = mutablePathFromInput(updateInput)
    expect(path).toBe("/repo/.env")
    expect(path).not.toBeNull()
    const verdict = evaluateSecretPath(path as string)
    expect(verdict.kind).toBe("deny")
  })

  test("NotebookEdit with notebook_path on .env.local: path extracted and secret-paths denies", () => {
    const notebookInput = {
      notebook_path: "/repo/.env.local",
      cell_id: "c1",
      new_source: "import os; print(os.environ)",
    }
    const path = mutablePathFromInput(notebookInput)
    expect(path).toBe("/repo/.env.local")
    const verdict = evaluateSecretPath(path as string)
    expect(verdict.kind).toBe("deny")
  })

  test("NotebookEdit with notebook_path on a benign .ipynb: passthrough on secret-paths", () => {
    // Sanity check: the gate doesn't flag every notebook edit
    const verdict = evaluateSecretPath("/repo/notebooks/analysis.ipynb")
    expect(verdict.kind).toBe("passthrough")
  })
})

describe("Enforcement P0 #3 — unknown / MCP tools during pre-ISA engagement", () => {
  // The shallow gate now `ask`s when the tool isn't in any known
  // category (read-only, write-class, Bash/Task/Agent/dispatcher) AND
  // engagement is required AND no accepted ISA exists yet.

  const engagedNoIsaCtx = {
    engagement_required: true,
    anyAcceptedIsaExists: false,
    acceptedWritePaths: ["/repo/.claude-hooks/work/sid/ISA.md"],
    acceptedEditPaths: ["/repo/.claude-hooks/work/sid/ISA.md"],
    acceptedMkdirDirs: ["/repo/.claude-hooks/work/sid"],
    displayIsaPath: ".claude-hooks/work/sid/ISA.md",
    displayIsaAbsolutePath: "/repo/.claude-hooks/work/sid/ISA.md",
    displayMkdirDir: ".claude-hooks/work/sid",
    toolInput: { path: "/repo/src/x.ts", content: "x" },
    resolvedToolFilePath: null as string | null,
  }

  test("mcp__filesystem__write_file during pre-ISA engagement → ask", () => {
    const v = evaluateEngagementGateShallow({
      ...engagedNoIsaCtx,
      toolName: "mcp__filesystem__write_file",
    })
    expect(v.kind).toBe("ask")
  })

  test("mcp__repo__apply_patch during pre-ISA engagement → ask", () => {
    const v = evaluateEngagementGateShallow({
      ...engagedNoIsaCtx,
      toolName: "mcp__repo__apply_patch",
    })
    expect(v.kind).toBe("ask")
  })

  test("weird_third_party_write_tool during pre-ISA engagement → ask", () => {
    const v = evaluateEngagementGateShallow({
      ...engagedNoIsaCtx,
      toolName: "weird_third_party_write_tool",
    })
    expect(v.kind).toBe("ask")
  })

  test("Read during pre-ISA engagement still passes through (known read-only)", () => {
    const v = evaluateEngagementGateShallow({
      ...engagedNoIsaCtx,
      toolName: "Read",
    })
    expect(v.kind).toBe("passthrough")
  })

  test("Grep during pre-ISA engagement still passes through (known read-only)", () => {
    const v = evaluateEngagementGateShallow({
      ...engagedNoIsaCtx,
      toolName: "Grep",
    })
    expect(v.kind).toBe("passthrough")
  })

  test("after ISA exists, unknown tool is permissive again (engagement released)", () => {
    const v = evaluateEngagementGateShallow({
      ...engagedNoIsaCtx,
      anyAcceptedIsaExists: true,
      toolName: "mcp__filesystem__write_file",
    })
    expect(v.kind).toBe("passthrough")
  })

  test("when engagement is not required, unknown tool is permissive", () => {
    const v = evaluateEngagementGateShallow({
      ...engagedNoIsaCtx,
      engagement_required: false,
      toolName: "mcp__filesystem__write_file",
    })
    expect(v.kind).toBe("passthrough")
  })
})

describe("Enforcement P0 #6 — Bash heredoc / write-class command at strict E4", () => {
  const strictE4 = {
    mode: "strict" as const,
    lastTier: 4,
    activeWorkerCount: 0,
    isWorkerSession: false,
  }

  test("cat > src/x.ts <<EOF at strict E4 with no worker → deny", () => {
    const v = evaluateWorkerMandatoryGate({
      ...strictE4,
      toolName: "Bash",
      bashCommand: "cat > src/x.ts <<EOF\nhello\nEOF",
    })
    expect(v.kind).toBe("deny")
  })

  test("tee src/x.ts at strict E4 → deny", () => {
    const v = evaluateWorkerMandatoryGate({
      ...strictE4,
      toolName: "Bash",
      bashCommand: "echo y | tee src/x.ts",
    })
    expect(v.kind).toBe("deny")
  })

  test("sed -i src/x.ts at strict E4 → deny", () => {
    const v = evaluateWorkerMandatoryGate({
      ...strictE4,
      toolName: "Bash",
      bashCommand: "sed -i 's/a/b/' src/x.ts",
    })
    expect(v.kind).toBe("deny")
  })

  test("python -c open().write at strict E4 → deny", () => {
    const v = evaluateWorkerMandatoryGate({
      ...strictE4,
      toolName: "Bash",
      bashCommand: "python -c \"open('src/x.ts','w').write('y')\"",
    })
    expect(v.kind).toBe("deny")
  })

  test("read-only Bash (ls) at strict E4 → passthrough", () => {
    const v = evaluateWorkerMandatoryGate({
      ...strictE4,
      toolName: "Bash",
      bashCommand: "ls -la src/",
    })
    expect(v.kind).toBe("passthrough")
  })

  test("read-only Bash (git status) at strict E4 → passthrough", () => {
    const v = evaluateWorkerMandatoryGate({
      ...strictE4,
      toolName: "Bash",
      bashCommand: "git status",
    })
    expect(v.kind).toBe("passthrough")
  })

  test("write-class Bash at recommend E4 → ask (not deny)", () => {
    const v = evaluateWorkerMandatoryGate({
      ...strictE4,
      mode: "recommend",
      toolName: "Bash",
      bashCommand: "cat > src/x.ts <<EOF\ny\nEOF",
    })
    expect(v.kind).toBe("ask")
  })

  test("write-class Bash at tier 3 (below threshold) → passthrough", () => {
    const v = evaluateWorkerMandatoryGate({
      ...strictE4,
      lastTier: 3,
      toolName: "Bash",
      bashCommand: "cat > src/x.ts <<EOF\ny\nEOF",
    })
    expect(v.kind).toBe("passthrough")
  })

  test("write-class Bash at strict E4 with active worker → allow (worker is the delegate)", () => {
    const v = evaluateWorkerMandatoryGate({
      ...strictE4,
      activeWorkerCount: 1,
      toolName: "Bash",
      bashCommand: "cat > src/x.ts <<EOF\ny\nEOF",
    })
    expect(v.kind).toBe("allow")
  })

  test("write-class Bash inside worker session → passthrough", () => {
    const v = evaluateWorkerMandatoryGate({
      ...strictE4,
      toolName: "Bash",
      bashCommand: "cat > src/x.ts <<EOF\ny\nEOF",
      isWorkerSession: true,
    })
    expect(v.kind).toBe("passthrough")
  })

  test("Bash WITHOUT bashCommand field → passthrough (back-compat)", () => {
    const v = evaluateWorkerMandatoryGate({
      ...strictE4,
      toolName: "Bash",
      // bashCommand intentionally omitted — pre-P0 callers
    })
    expect(v.kind).toBe("passthrough")
  })
})
