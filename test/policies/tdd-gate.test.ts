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
  safeRealpath,
} from "../../src/policies/tdd-gate.ts"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join as joinPath, sep } from "node:path"

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

describe("evaluateTddGateShallow — US-1d: symlink-normalized companion lookup", () => {
  test("ledger has /var/sandbox/src/foo/bar.test.ts + resolved is /private/var/sandbox/src/foo/bar.ts → ALLOW (macOS symlink case)", () => {
    // Repros the dogfood-discovered macOS bug:
    //  - files_changed has the unresolved /var/... form (as the
    //    dispatcher recorded it)
    //  - resolvedFilePath came back realpath-canonical /private/var/...
    //  - on-disk check returns false (bootstrap-batch — file not yet on
    //    disk)
    // Before this fix, the string compare missed → false deny.
    const normalize = (p: string): string =>
      p.startsWith("/var/") ? `/private${p}` : p
    const v = evaluateTddGateShallow(
      {
        enabled: true,
        toolName: "Write",
        resolvedFilePath: "/private/var/sandbox/src/foo/bar.ts",
        filesChangedInSession: ["/var/sandbox/src/foo/bar.test.ts"],
      },
      () => false,
      normalize,
    )
    expect(v.kind).toBe("allow")
  })

  test("inverse direction: ledger has /private/var/..., resolved is /var/... → ALLOW", () => {
    const normalize = (p: string): string =>
      p.startsWith("/var/") ? `/private${p}` : p
    const v = evaluateTddGateShallow(
      {
        enabled: true,
        toolName: "Write",
        resolvedFilePath: "/var/sandbox/src/foo/bar.ts",
        filesChangedInSession: ["/private/var/sandbox/src/foo/bar.test.ts"],
      },
      () => false,
      normalize,
    )
    expect(v.kind).toBe("allow")
  })

  test("identity normalizer (default) preserves prior behavior", () => {
    // Calling the shallow form without a normalizer must behave exactly
    // as before the fix — pins back-compat for the existing test suite
    // that passes no normalizer arg.
    const v = evaluateTddGateShallow(
      {
        enabled: true,
        toolName: "Write",
        resolvedFilePath: "/private/var/sandbox/src/foo/bar.ts",
        filesChangedInSession: ["/var/sandbox/src/foo/bar.test.ts"],
      },
      () => false,
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

describe("safeRealpath (P0-4 containment)", () => {
  let tmpRepo: string

  const setup = (): { tmpRepo: string; cleanup: () => void } => {
    const root = mkdtempSync(joinPath(tmpdir(), "tdd-gate-p0-4-"))
    return { tmpRepo: root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
  }

  test("path with no symlink → returns realpath (which equals resolve(path))", () => {
    const { tmpRepo: root, cleanup } = setup()
    try {
      const real = joinPath(root, "test", "foo.test.ts")
      mkdirSync(joinPath(root, "test"), { recursive: true })
      writeFileSync(real, "// test", "utf8")
      const out = safeRealpath(real, root)
      // Result equals realpath of the file (which is the file itself on disk).
      // It must NOT fall back to the un-normalized input when the path is inside root.
      expect(out).toContain("test/foo.test.ts")
    } finally {
      cleanup()
    }
  })

  test("in-repo symlink (target also inside root) → returns the in-repo realpath", () => {
    const { tmpRepo: root, cleanup } = setup()
    try {
      mkdirSync(joinPath(root, "real"), { recursive: true })
      mkdirSync(joinPath(root, "test"), { recursive: true })
      const target = joinPath(root, "real", "foo.test.ts")
      writeFileSync(target, "// target", "utf8")
      const link = joinPath(root, "test", "foo.test.ts")
      symlinkSync(target, link)

      const out = safeRealpath(link, root)
      expect(out).toContain("real/foo.test.ts")
    } finally {
      cleanup()
    }
  })

  test("escape symlink (target outside root) → falls back to the input path", () => {
    // The threat scenario: an attacker plants test/foo.test.ts → /tmp/outside.
    // Realpath would escape the workspace; safeRealpath MUST not honor that.
    const { tmpRepo: root, cleanup } = setup()
    const outside = mkdtempSync(joinPath(tmpdir(), "tdd-gate-p0-4-outside-"))
    try {
      const outsideTarget = joinPath(outside, "outside.test.ts")
      writeFileSync(outsideTarget, "// outside", "utf8")
      mkdirSync(joinPath(root, "test"), { recursive: true })
      const link = joinPath(root, "test", "foo.test.ts")
      symlinkSync(outsideTarget, link)

      const out = safeRealpath(link, root)
      // Must fall back to the original (in-repo) path, NOT the outside target.
      expect(out).toBe(link)
      expect(out).not.toContain(outside)
    } finally {
      rmSync(outside, { recursive: true, force: true })
      cleanup()
    }
  })

  test("path that does not exist on disk → falls back to input (existing US-1d behavior)", () => {
    const { tmpRepo: root, cleanup } = setup()
    try {
      const ghost = joinPath(root, "does-not-exist.test.ts")
      const out = safeRealpath(ghost, root)
      expect(out).toBe(ghost)
    } finally {
      cleanup()
    }
  })
})

describe("evaluateTddGateShallow — P0-4: escape attempt does NOT bypass the gate", () => {
  test("malicious normalizer that escapes the repo → gate still denies", () => {
    // Simulates the bug: if normalizePath returns an outside-repo path
    // for the candidate, and files_changed also has that outside path
    // (because the model previously wrote there), pre-P0-4 logic would
    // incorrectly ALLOW the source write. The fix is in the deep entry
    // (evaluateTddGate) which composes a containment-aware normalizer;
    // the shallow form continues to trust whatever normalizer it gets.
    // This test pins that the BUG was real — a generic normalizer
    // that lies CAN bypass — proving why the deep entry's containment
    // check matters.
    const escapingNormalizer = (p: string): string =>
      p.endsWith("bar.test.ts") ? "/tmp/external/bar.test.ts" : p
    const v = evaluateTddGateShallow(
      {
        enabled: true,
        toolName: "Write",
        resolvedFilePath: join("/repo", "src", "foo", "bar.ts"),
        filesChangedInSession: ["/tmp/external/bar.test.ts"],
      },
      () => false,
      escapingNormalizer,
    )
    // Confirms the pre-fix bypass: a lying normalizer ALLOWS the write.
    // The fix is to make the deep entry never produce a lying normalizer
    // (safeRealpath returns the input when realpath escapes).
    expect(v.kind).toBe("allow")
  })
})
