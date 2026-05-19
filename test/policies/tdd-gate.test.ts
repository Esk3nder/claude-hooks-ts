/**
 * TDD-first gate (US-1) pure-decision tests. The Effect-side wrapper in
 * events/pretool-policy.ts is covered by integration tests elsewhere;
 * here we pin the decision matrix directly.
 */
import { describe, expect, test } from "bun:test"
import {
  evaluateTddGateShallow,
  inferTestPaths,
  isTestFilePath,
} from "../../src/policies/tdd-gate.ts"
import { sep } from "node:path"

const join = (...segs: string[]): string => segs.join(sep)

const neverExists = (_path: string): boolean => false
const alwaysExists = (_path: string): boolean => true
const existsIn = (paths: ReadonlyArray<string>) => (p: string): boolean =>
  paths.includes(p)

const baseInput = {
  enabled: true,
  toolName: "Write",
  resolvedFilePath: join("/repo", "src", "foo", "bar.ts"),
  filesChangedInSession: [] as ReadonlyArray<string>,
}

describe("isTestFilePath", () => {
  test.each<[string, boolean]>([
    [join("src", "foo.ts"), false],
    [join("src", "foo.test.ts"), true],
    [join("src", "foo.spec.tsx"), true],
    [join("test", "foo.ts"), true],
    [join("tests", "foo.ts"), true],
    [join("src", "__tests__", "foo.ts"), true],
    [join("scripts", "deploy.ts"), false],
    [join("docs", "readme.md"), false],
  ])("isTestFilePath(%p) → %p", (input, expected) => {
    expect(isTestFilePath(input)).toBe(expected)
  })
})

describe("inferTestPaths", () => {
  test("ts source → inline + __tests__ + sibling test/ candidates", () => {
    const out = inferTestPaths(join("/repo", "src", "foo", "bar.ts"))
    expect(out).toContain(join("/repo", "src", "foo", "bar.test.ts"))
    expect(out).toContain(join("/repo", "src", "foo", "__tests__", "bar.test.ts"))
    expect(out).toContain(join("/repo", "test", "foo", "bar.test.ts"))
  })
  test("tsx source → tsx + ts variants emitted", () => {
    const out = inferTestPaths(join("/repo", "src", "ui", "Card.tsx"))
    expect(out).toContain(join("/repo", "src", "ui", "Card.test.tsx"))
    expect(out).toContain(join("/repo", "src", "ui", "Card.test.ts"))
  })
  test("no extension → empty list", () => {
    expect(inferTestPaths("/repo/no-ext-here")).toEqual([])
  })
  test("path with no src segment → no mirrored test/ candidate", () => {
    const out = inferTestPaths(join("/repo", "lib", "foo.ts"))
    expect(out).toContain(join("/repo", "lib", "foo.test.ts"))
    expect(out.every((p) => !p.includes(`${sep}test${sep}`))).toBe(true)
  })
})

describe("evaluateTddGateShallow — short-circuits", () => {
  test("enabled=false → passthrough", () => {
    const v = evaluateTddGateShallow(
      { ...baseInput, enabled: false },
      neverExists,
    )
    expect(v.kind).toBe("passthrough")
  })
  test("non-write tool (Read) → passthrough", () => {
    const v = evaluateTddGateShallow(
      { ...baseInput, toolName: "Read" },
      neverExists,
    )
    expect(v.kind).toBe("passthrough")
  })
  test("non-write tool (Bash) → passthrough", () => {
    const v = evaluateTddGateShallow(
      { ...baseInput, toolName: "Bash" },
      neverExists,
    )
    expect(v.kind).toBe("passthrough")
  })
  test("null resolvedFilePath → passthrough", () => {
    const v = evaluateTddGateShallow(
      { ...baseInput, resolvedFilePath: null },
      neverExists,
    )
    expect(v.kind).toBe("passthrough")
  })
  test("writing to a test file itself → passthrough", () => {
    const v = evaluateTddGateShallow(
      {
        ...baseInput,
        resolvedFilePath: join("/repo", "test", "foo", "bar.test.ts"),
      },
      neverExists,
    )
    expect(v.kind).toBe("passthrough")
  })
  test("writing to a non-src path (docs/) → passthrough", () => {
    const v = evaluateTddGateShallow(
      { ...baseInput, resolvedFilePath: join("/repo", "docs", "guide.md") },
      neverExists,
    )
    expect(v.kind).toBe("passthrough")
  })
})

describe("evaluateTddGateShallow — allow paths", () => {
  test("companion test exists on disk → allow", () => {
    const v = evaluateTddGateShallow(
      baseInput,
      existsIn([join("/repo", "test", "foo", "bar.test.ts")]),
    )
    expect(v.kind).toBe("allow")
    expect(v.kind === "allow" && v.reason).toMatch(/exists on disk/)
  })
  test("companion test touched in this session → allow (bootstrap escape)", () => {
    const v = evaluateTddGateShallow(
      {
        ...baseInput,
        filesChangedInSession: [
          join("/repo", "src", "foo", "bar.test.ts"),
        ],
      },
      neverExists,
    )
    expect(v.kind).toBe("allow")
    expect(v.kind === "allow" && v.reason).toMatch(/touched in this session/)
  })
  test("session-touched takes precedence over no disk match", () => {
    // The bootstrap path is the only thing that lets a fresh new feature
    // ship in two writes: test first, then implementation.
    const v = evaluateTddGateShallow(
      {
        ...baseInput,
        filesChangedInSession: [
          join("/repo", "src", "foo", "__tests__", "bar.test.ts"),
        ],
      },
      neverExists,
    )
    expect(v.kind).toBe("allow")
  })
  test("Edit tool also gated; allows when test exists", () => {
    const v = evaluateTddGateShallow(
      { ...baseInput, toolName: "Edit" },
      alwaysExists,
    )
    expect(v.kind).toBe("allow")
  })
})

describe("evaluateTddGateShallow — deny", () => {
  test("no companion test on disk and none in session → deny", () => {
    const v = evaluateTddGateShallow(baseInput, neverExists)
    expect(v.kind).toBe("deny")
    if (v.kind === "deny") {
      expect(v.reason).toContain("TDD gate")
      expect(v.reason).toContain("src/foo/bar.ts".replace(/\//g, sep))
      // The deny message names at least one candidate test path.
      expect(v.reason).toMatch(/bar\.test\.ts|bar\.spec\.ts/)
    }
  })
  test("touched files that are NOT companion tests don't satisfy", () => {
    const v = evaluateTddGateShallow(
      {
        ...baseInput,
        filesChangedInSession: [
          join("/repo", "src", "foo", "bar.ts"),
          join("/repo", "src", "other", "thing.test.ts"),
        ],
      },
      neverExists,
    )
    expect(v.kind).toBe("deny")
  })
  test("MultiEdit on src without a test → deny", () => {
    const v = evaluateTddGateShallow(
      { ...baseInput, toolName: "MultiEdit" },
      neverExists,
    )
    expect(v.kind).toBe("deny")
  })
  test("NotebookEdit on src without a test → deny", () => {
    const v = evaluateTddGateShallow(
      { ...baseInput, toolName: "NotebookEdit" },
      neverExists,
    )
    expect(v.kind).toBe("deny")
  })
})

describe("evaluateTddGateShallow — disable escape", () => {
  test("flag off keeps existing behavior even with deny-worthy state", () => {
    const v = evaluateTddGateShallow(
      { ...baseInput, enabled: false },
      neverExists,
    )
    expect(v.kind).toBe("passthrough")
  })
})
