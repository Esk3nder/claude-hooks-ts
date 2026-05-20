/**
 * Unit tests for the unified write-class tool surface.
 *
 * Pins the contract that the three enforcement modules
 * (pretool-policy, engagement-gate, worker-mandatory) depend on.
 */

import { describe, expect, test } from "bun:test"
import {
  isBashFileWrite,
  isUnknownTool,
  KNOWN_READ_ONLY_TOOLS,
  mutablePathFromInput,
  WRITE_CLASS_TOOLS,
} from "../../src/policies/write-class.ts"

describe("WRITE_CLASS_TOOLS", () => {
  test.each<string>([
    "Edit",
    "Write",
    "MultiEdit",
    "Update",
    "NotebookEdit",
  ])("%s is write-class", (tool) => {
    expect(WRITE_CLASS_TOOLS.has(tool)).toBe(true)
  })

  test.each<string>(["Read", "Grep", "Bash", "Task"])(
    "%s is NOT write-class",
    (tool) => {
      expect(WRITE_CLASS_TOOLS.has(tool)).toBe(false)
    },
  )
})

describe("mutablePathFromInput", () => {
  test("Edit-shaped: returns file_path", () => {
    expect(mutablePathFromInput({ file_path: "/repo/src/x.ts" })).toBe(
      "/repo/src/x.ts",
    )
  })

  test("NotebookEdit-shaped: returns notebook_path", () => {
    expect(
      mutablePathFromInput({ notebook_path: "/repo/n.ipynb", cell_id: "c1" }),
    ).toBe("/repo/n.ipynb")
  })

  test("both fields present: file_path wins (Edit semantics)", () => {
    expect(
      mutablePathFromInput({
        file_path: "/a.ts",
        notebook_path: "/b.ipynb",
      }),
    ).toBe("/a.ts")
  })

  test("neither field: returns null", () => {
    expect(mutablePathFromInput({ other: 1 })).toBe(null)
  })

  test("null / non-object: returns null", () => {
    expect(mutablePathFromInput(null)).toBe(null)
    expect(mutablePathFromInput(undefined)).toBe(null)
    expect(mutablePathFromInput("string")).toBe(null)
    expect(mutablePathFromInput(42)).toBe(null)
  })

  test("empty string path: returns null (treat as missing)", () => {
    expect(mutablePathFromInput({ file_path: "" })).toBe(null)
    expect(mutablePathFromInput({ notebook_path: "" })).toBe(null)
  })
})

describe("isBashFileWrite — positive cases", () => {
  test.each<string>([
    "cat > src/x.ts <<EOF\nhello\nEOF",
    "cat > /tmp/foo",
    "cat >> /tmp/foo",
    "echo hi > src/x.ts",
    "echo hi >> src/x.ts",
    "printf '%s\\n' hi > src/x.ts",
    "tee src/x.ts",
    "tee -a src/x.ts",
    "sed -i 's/a/b/' src/x.ts",
    "sed -i.bak 's/a/b/' src/x.ts",
    "perl -pi -e 's/a/b/' src/x.ts",
    "python -c \"open('src/x.ts','w').write('y')\"",
    "python3 -c \"from pathlib import Path; Path('x.ts').write_text('y')\"",
    "node -e 'require(\"fs\").writeFileSync(\"x.ts\",\"y\")'",
    "cp src/foo.ts src/bar.ts",
    "mv src/foo.ts src/bar.ts",
    "touch src/new.ts",
    "git apply patch.diff",
    "git am < /tmp/patch.mbox",
    "dd if=/dev/urandom of=src/x.bin count=1",
    // Heredoc with surrounding chain
    "cd /repo && cat > src/x.ts <<EOF\ny\nEOF",
  ])("write: %s", (cmd) => {
    expect(isBashFileWrite(cmd)).toBe(true)
  })
})

describe("isBashFileWrite — negative cases", () => {
  test.each<string>([
    "ls",
    "ls -la src/",
    "grep -r foo src/",
    "rg foo src/",
    "cat src/foo.ts",
    "cat src/foo.ts | head",
    "echo hi",
    "echo hi > /dev/null",  // /dev/null isn't a file write we care about
    "git status",
    "git log --oneline",
    "git diff src/",
    "bun test",
    "bun run typecheck",
    "node -e 'console.log(1)'",
    "python -c 'print(1)'",
    "find . -name '*.ts'",
    "pwd",
    "",
  ])("read-only: %s", (cmd) => {
    expect(isBashFileWrite(cmd)).toBe(false)
  })
})

describe("isUnknownTool", () => {
  test.each<[string, boolean]>([
    ["Edit", false],
    ["Write", false],
    ["MultiEdit", false],
    ["Update", false],
    ["NotebookEdit", false],
    ["Read", false],
    ["Grep", false],
    ["Bash", false],
    ["Task", false],
    ["Agent", false],
    ["TodoWrite", false],
    // Engagement-allowlist members folded into write-class sets so the
    // unknown-tool ask branch matches the engagement-gate allowlist
    // (PR #72 self-review non-blocker #2):
    ["Skill", false],
    ["AskUserQuestion", false],
    ["List", false],
    ["NotebookRead", false],
    ["mcp__filesystem__write_file", true],
    ["mcp__docs__search", true],
    ["mcp__repo__apply_patch", true],
    ["weird_third_party_tool", true],
  ])("%s → unknown=%s", (tool, expected) => {
    expect(isUnknownTool(tool)).toBe(expected)
  })
})

describe("KNOWN_READ_ONLY_TOOLS", () => {
  test("includes the standard Claude Code read-only tools", () => {
    for (const t of ["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch"]) {
      expect(KNOWN_READ_ONLY_TOOLS.has(t)).toBe(true)
    }
  })
})
