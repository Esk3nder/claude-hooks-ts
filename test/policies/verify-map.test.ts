import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_VERIFY_PRIORITY,
  DEFAULT_VERIFY_TIMEOUT_MS,
  MAX_VERIFY_TIMEOUT_MS,
  loadVerifyRules,
  matchVerifyRules,
  parseVerifyMapYaml,
  runVerifyCommand,
  selectVerifyCommand,
  tailOf,
  verifyMapPathFor,
} from "../../src/policies/verify-map.ts"

const stage = (): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "chts-verify-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const writeYaml = (root: string, contents: string): void => {
  mkdirSync(join(root, ".claude-hooks"), { recursive: true })
  writeFileSync(verifyMapPathFor(root), contents, "utf-8")
}

describe("verifyMapPathFor", () => {
  test("path is <root>/.claude-hooks/verify-map.yaml", () => {
    expect(verifyMapPathFor("/tmp/x")).toBe(
      "/tmp/x/.claude-hooks/verify-map.yaml",
    )
  })
})

describe("parseVerifyMapYaml", () => {
  test("returns empty rules when no `rules:` key", () => {
    const r = parseVerifyMapYaml("# just comments\nfoo: bar\n")
    expect(r._tag).toBe("ok")
    if (r._tag === "ok") expect(r.rules.length).toBe(0)
  })

  test("parses single rule with shell-string command and defaults", () => {
    const r = parseVerifyMapYaml(`rules:
  - source: src/*.ts
    command: bun test
`)
    expect(r._tag).toBe("ok")
    if (r._tag === "ok") {
      expect(r.rules.length).toBe(1)
      expect(r.rules[0]).toEqual({
        source: "src/*.ts",
        command: "bun test",
        timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
        priority: DEFAULT_VERIFY_PRIORITY,
      })
    }
  })

  test("parses array-form command with explicit timeoutMs and priority", () => {
    const r = parseVerifyMapYaml(`rules:
  - source: src/algorithm/*.ts
    command: ["bun", "test", "test/algorithm"]
    timeoutMs: 18000
    priority: 5
`)
    expect(r._tag).toBe("ok")
    if (r._tag === "ok") {
      expect(r.rules.length).toBe(1)
      expect(r.rules[0]?.command).toEqual(["bun", "test", "test/algorithm"])
      expect(r.rules[0]?.timeoutMs).toBe(18000)
      expect(r.rules[0]?.priority).toBe(5)
    }
  })

  test("clamps oversize timeoutMs to MAX_VERIFY_TIMEOUT_MS", () => {
    const r = parseVerifyMapYaml(`rules:
  - source: src/*.ts
    command: x
    timeoutMs: 99999
`)
    expect(r._tag).toBe("ok")
    if (r._tag === "ok") {
      expect(r.rules[0]?.timeoutMs).toBe(MAX_VERIFY_TIMEOUT_MS)
    }
  })

  test("rejects rule missing required source or command", () => {
    const r = parseVerifyMapYaml(`rules:
  - source: src/*.ts
  - command: only-command
`)
    expect(r._tag).toBe("ok")
    if (r._tag === "ok") expect(r.rules.length).toBe(0)
  })

  test("parses multiple rules", () => {
    const r = parseVerifyMapYaml(`rules:
  - source: a.ts
    command: cmd1
  - source: b.ts
    command: cmd2
`)
    expect(r._tag).toBe("ok")
    if (r._tag === "ok") expect(r.rules.length).toBe(2)
  })
})

describe("matchVerifyRules", () => {
  const rules = [
    { source: "src/*.ts", command: "a", timeoutMs: 1000, priority: 100 },
    { source: "test/*.ts", command: "b", timeoutMs: 1000, priority: 100 },
    { source: "src/algorithm/*.ts", command: "c", timeoutMs: 1000, priority: 100 },
  ]

  test("returns rules whose source glob matches any changed file", () => {
    const matched = matchVerifyRules(["src/foo.ts"], rules)
    expect(matched.map((r) => r.command)).toEqual(["a"])
  })

  test("returns nothing when no glob matches", () => {
    const matched = matchVerifyRules(["docs/x.md"], rules)
    expect(matched).toEqual([])
  })

  test("returns all rules whose source matches (matcher is `*`=`.*`, crosses `/`)", () => {
    // The matcher mirrors regenerate.ts: `*` compiles to `.*`, so `src/*.ts`
    // also matches `src/algorithm/foo.ts`. Both rules a and c match here.
    const matched = matchVerifyRules(["src/algorithm/foo.ts"], rules)
    expect(matched.map((r) => r.command).sort()).toEqual(["a", "c"])
  })

  test("./-prefixed source patterns match normalized repo-relative paths", () => {
    const matched = matchVerifyRules(["src/foo.ts"], [
      { source: "./src/*.ts", command: "x", timeoutMs: 1000, priority: 100 },
    ])
    expect(matched.map((r) => r.command)).toEqual(["x"])
  })
})

describe("selectVerifyCommand", () => {
  test("returns null when no rule matches", () => {
    const r = selectVerifyCommand(["docs/x.md"], [
      { source: "src/*.ts", command: "a", timeoutMs: 1000, priority: 100 },
    ])
    expect(r).toBeNull()
  })

  test("picks lowest priority first", () => {
    const rules = [
      { source: "src/*.ts", command: "low-prio", timeoutMs: 1000, priority: 100 },
      { source: "src/*.ts", command: "high-prio", timeoutMs: 1000, priority: 1 },
    ]
    const r = selectVerifyCommand(["src/foo.ts"], rules)
    expect(r?.command).toBe("high-prio")
  })

  test("ties broken by source specificity (more literal chars wins)", () => {
    const rules = [
      { source: "src/*.ts", command: "broad", timeoutMs: 1000, priority: 10 },
      { source: "src/algorithm.ts", command: "narrow", timeoutMs: 1000, priority: 10 },
    ]
    const r = selectVerifyCommand(["src/algorithm.ts"], rules)
    expect(r?.command).toBe("narrow")
  })

  test("ties broken by stable original order when priority and specificity match", () => {
    const rules = [
      { source: "src/a.ts", command: "first", timeoutMs: 1000, priority: 10 },
      { source: "src/b.ts", command: "second", timeoutMs: 1000, priority: 10 },
    ]
    const r = selectVerifyCommand(["src/a.ts", "src/b.ts"], rules)
    expect(r?.command).toBe("first")
  })
})

describe("loadVerifyRules", () => {
  test("returns [] when verify-map.yaml absent", () => {
    const { root, cleanup } = stage()
    try {
      expect(loadVerifyRules(root)).toEqual([])
    } finally {
      cleanup()
    }
  })

  test("parses a real file end-to-end", () => {
    const { root, cleanup } = stage()
    try {
      writeYaml(root, `rules:
  - source: src/*.ts
    command: bun test
    priority: 1
`)
      const rules = loadVerifyRules(root)
      expect(rules.length).toBe(1)
      expect(rules[0]?.priority).toBe(1)
    } finally {
      cleanup()
    }
  })
})

describe("runVerifyCommand", () => {
  test("returns exit 0 on successful command", async () => {
    const result = await runVerifyCommand(
      { source: "*", command: ["true"], timeoutMs: 5000, priority: 100 },
      process.cwd(),
    )
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
  })

  test("captures non-zero exit", async () => {
    const result = await runVerifyCommand(
      { source: "*", command: ["false"], timeoutMs: 5000, priority: 100 },
      process.cwd(),
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.timedOut).toBe(false)
  })

  test("captures stderr output on failure", async () => {
    const result = await runVerifyCommand(
      {
        source: "*",
        command: ["sh", "-c", "echo failmsg 1>&2; exit 2"],
        timeoutMs: 5000,
        priority: 100,
      },
      process.cwd(),
    )
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("failmsg")
  })

  test("times out a long-running command", async () => {
    const result = await runVerifyCommand(
      {
        source: "*",
        command: ["sh", "-c", "sleep 5"],
        timeoutMs: 200,
        priority: 100,
      },
      process.cwd(),
    )
    expect(result.timedOut).toBe(true)
  })

  test("handles empty command argv gracefully", async () => {
    const result = await runVerifyCommand(
      { source: "*", command: [], timeoutMs: 5000, priority: 100 },
      process.cwd(),
    )
    expect(result.exitCode).toBe(-1)
    expect(result.stderr).toContain("empty command")
  })
})

describe("tailOf", () => {
  test("returns unchanged when shorter than maxChars", () => {
    expect(tailOf("abc", 10)).toBe("abc")
  })

  test("returns ellipsised tail when longer than maxChars", () => {
    const r = tailOf("abcdefghij", 4)
    expect(r.length).toBeGreaterThan(0)
    expect(r.endsWith("ghij")).toBe(true)
    expect(r.startsWith("…")).toBe(true)
  })
})
