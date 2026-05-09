import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadRegenerateRules,
  matchRules,
  parseRegenerateYaml,
  regeneratePathFor,
} from "../../src/policies/regenerate.ts"

const stage = (): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "chts-regen-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const writeYaml = (root: string, contents: string): void => {
  mkdirSync(join(root, ".claude-hooks"), { recursive: true })
  writeFileSync(regeneratePathFor(root), contents, "utf-8")
}

describe("regeneratePathFor", () => {
  test("path is <root>/.claude-hooks/regenerate.yaml", () => {
    expect(regeneratePathFor("/tmp/x")).toBe("/tmp/x/.claude-hooks/regenerate.yaml")
  })
})

describe("parseRegenerateYaml", () => {
  test("returns empty rules when no `rules:` key", () => {
    const r = parseRegenerateYaml("# just comments\nfoo: bar\n")
    expect(r._tag).toBe("ok")
    if (r._tag === "ok") expect(r.rules.length).toBe(0)
  })

  test("parses single rule with shell-string command", () => {
    const r = parseRegenerateYaml(`rules:
  - source: docs/architecture.md
    derived: docs/SUMMARY.md
    command: bun run scripts/gen.ts
`)
    expect(r._tag).toBe("ok")
    if (r._tag === "ok") {
      expect(r.rules.length).toBe(1)
      expect(r.rules[0]).toEqual({
        source: "docs/architecture.md",
        derived: "docs/SUMMARY.md",
        command: "bun run scripts/gen.ts",
      })
    }
  })

  test("parses array-form command", () => {
    const r = parseRegenerateYaml(`rules:
  - source: a
    derived: b
    command: ["bun", "run", "scripts/x.ts"]
`)
    expect(r._tag).toBe("ok")
    if (r._tag === "ok") {
      expect(r.rules[0]?.command).toEqual(["bun", "run", "scripts/x.ts"])
    }
  })

  test("parses multiple rules", () => {
    const r = parseRegenerateYaml(`rules:
  - source: a.md
    derived: a-summary.md
    command: cmd1
  - source: b.md
    derived: b-summary.md
    command: cmd2
`)
    expect(r._tag).toBe("ok")
    if (r._tag === "ok") expect(r.rules.length).toBe(2)
  })

  test("strips surrounding quotes (upstream quirk parity)", () => {
    const r = parseRegenerateYaml(`rules:
  - source: "a b c.md"
    derived: 'd e f.md'
    command: "echo hi"
`)
    if (r._tag === "ok") {
      expect(r.rules[0]?.source).toBe("a b c.md")
      expect(r.rules[0]?.derived).toBe("d e f.md")
      expect(r.rules[0]?.command).toBe("echo hi")
    }
  })

  test("ignores trailing `# comments`", () => {
    const r = parseRegenerateYaml(`rules:
  - source: a # the source
    derived: b # the derived
    command: c # cmd
`)
    if (r._tag === "ok") {
      expect(r.rules[0]?.source).toBe("a")
      expect(r.rules[0]?.derived).toBe("b")
      expect(r.rules[0]?.command).toBe("c")
    }
  })

  test("F4: `#` inside double-quoted value is NOT treated as comment", () => {
    const r = parseRegenerateYaml(`rules:
  - source: x
    derived: y
    command: "echo hi # not a comment"
`)
    if (r._tag === "ok") {
      // After quote-strip, command should still contain the `#` segment
      expect(r.rules[0]?.command).toBe("echo hi # not a comment")
    }
  })

  test("F4: `#` inside single-quoted value is NOT treated as comment", () => {
    const r = parseRegenerateYaml(`rules:
  - source: x
    derived: y
    command: 'echo hi # not a comment'
`)
    if (r._tag === "ok") {
      expect(r.rules[0]?.command).toBe("echo hi # not a comment")
    }
  })

  test("F4: `#` without leading whitespace is NOT a comment marker", () => {
    const r = parseRegenerateYaml(`rules:
  - source: x
    derived: y
    command: bun#weird-but-not-a-comment
`)
    if (r._tag === "ok") {
      expect(r.rules[0]?.command).toBe("bun#weird-but-not-a-comment")
    }
  })

  test("incomplete rule (missing field) is dropped", () => {
    const r = parseRegenerateYaml(`rules:
  - source: a
    command: c
`)
    if (r._tag === "ok") expect(r.rules.length).toBe(0)
  })
})

describe("matchRules — `*`-only glob", () => {
  test("exact match", () => {
    const rules = [{ source: "docs/a.md", derived: "x", command: "y" }]
    expect(matchRules(["docs/a.md"], rules).length).toBe(1)
    expect(matchRules(["docs/b.md"], rules).length).toBe(0)
  })
  test("`*` wildcard matches a path segment", () => {
    const rules = [{ source: "docs/*.md", derived: "x", command: "y" }]
    expect(matchRules(["docs/a.md"], rules).length).toBe(1)
    expect(matchRules(["docs/b.md"], rules).length).toBe(1)
    expect(matchRules(["docs/sub/c.md"], rules).length).toBe(1) // `*` matches `/`
  })
  test("a rule fires once even when multiple files match", () => {
    const rules = [{ source: "docs/*.md", derived: "x", command: "y" }]
    expect(matchRules(["docs/a.md", "docs/b.md"], rules).length).toBe(1)
  })
  test("multiple matching rules → multiple matches", () => {
    const rules = [
      { source: "a", derived: "x", command: "y" },
      { source: "b", derived: "x", command: "y" },
    ]
    expect(matchRules(["a", "b"], rules).length).toBe(2)
  })
  test("no changed files → no matches", () => {
    const rules = [{ source: "a", derived: "x", command: "y" }]
    expect(matchRules([], rules).length).toBe(0)
  })
  test("regex metachars in source are escaped (not interpreted)", () => {
    const rules = [{ source: "a.b.c", derived: "x", command: "y" }]
    expect(matchRules(["axbxc"], rules).length).toBe(0) // `.` is literal
    expect(matchRules(["a.b.c"], rules).length).toBe(1)
  })
})

describe("loadRegenerateRules — disk integration", () => {
  test("returns [] when file absent", () => {
    const { root, cleanup } = stage()
    try {
      expect(loadRegenerateRules(root)).toEqual([])
    } finally {
      cleanup()
    }
  })

  test("returns parsed rules when file present", () => {
    const { root, cleanup } = stage()
    try {
      writeYaml(
        root,
        `rules:\n  - source: x\n    derived: y\n    command: z\n`,
      )
      const rules = loadRegenerateRules(root)
      expect(rules.length).toBe(1)
      expect(rules[0]?.source).toBe("x")
    } finally {
      cleanup()
    }
  })
})
