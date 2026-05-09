import { describe, expect, test } from "bun:test"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ARTIFACT_FILENAME,
  LEGACY_ARTIFACT_FILENAME,
  findArtifactPath,
  findLatestISA,
  findProjectIsa,
  isIsaFilePath,
  workDirFor,
} from "../../../src/algorithm/isa/locate.ts"

interface Staged {
  readonly root: string
  readonly cleanup: () => void
}

const stage = (): Staged => {
  const root = mkdtempSync(join(tmpdir(), "chts-isa-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const writeIsa = (root: string, slug: string, mtimeSeconds: number): string => {
  const dir = join(workDirFor(root), slug)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, ARTIFACT_FILENAME)
  writeFileSync(file, `## Goal\n${slug}\n`, "utf8")
  utimesSync(file, mtimeSeconds, mtimeSeconds)
  return file
}

const writeLegacyPrd = (root: string, slug: string): string => {
  const dir = join(workDirFor(root), slug)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, LEGACY_ARTIFACT_FILENAME)
  writeFileSync(file, `## Goal\nlegacy ${slug}\n`, "utf8")
  return file
}

describe("constants — PAI lines 28-29", () => {
  test("ARTIFACT_FILENAME is ISA.md", () => {
    expect(ARTIFACT_FILENAME).toBe("ISA.md")
  })
  test("LEGACY_ARTIFACT_FILENAME is PRD.md", () => {
    expect(LEGACY_ARTIFACT_FILENAME).toBe("PRD.md")
  })
})

describe("workDirFor", () => {
  test("computes <root>/.claude-hooks/state/work", () => {
    expect(workDirFor("/tmp/x")).toBe("/tmp/x/.claude-hooks/state/work")
  })
  test("defaults to process.cwd()", () => {
    expect(workDirFor()).toBe(`${process.cwd()}/.claude-hooks/state/work`)
  })
})

describe("findArtifactPath — PAI lines 38-45 mirror", () => {
  test("returns ISA.md when present", () => {
    const { root, cleanup } = stage()
    try {
      const expected = writeIsa(root, "20260509_a", 1)
      expect(findArtifactPath("20260509_a", root)).toBe(expected)
    } finally {
      cleanup()
    }
  })

  test("falls back to legacy PRD.md when ISA.md absent", () => {
    const { root, cleanup } = stage()
    try {
      const expected = writeLegacyPrd(root, "old_session")
      expect(findArtifactPath("old_session", root)).toBe(expected)
    } finally {
      cleanup()
    }
  })

  test("prefers ISA.md when both are present (PAI's documented behavior)", () => {
    const { root, cleanup } = stage()
    try {
      writeLegacyPrd(root, "both")
      const expected = writeIsa(root, "both", 1)
      expect(findArtifactPath("both", root)).toBe(expected)
    } finally {
      cleanup()
    }
  })

  test("returns null when neither file exists", () => {
    const { root, cleanup } = stage()
    try {
      expect(findArtifactPath("missing-slug", root)).toBeNull()
    } finally {
      cleanup()
    }
  })

  test("returns null when work dir is absent entirely", () => {
    expect(findArtifactPath("any", "/tmp/non-existent-dir-123-xyz")).toBeNull()
  })
})

describe("findLatestISA — PAI lines 52-66 mirror", () => {
  test("picks the most recently modified ISA across slugs", () => {
    const { root, cleanup } = stage()
    try {
      writeIsa(root, "older", 1_000_000)
      const newer = writeIsa(root, "newer", 2_000_000)
      writeIsa(root, "oldest", 100)
      expect(findLatestISA(root)).toBe(newer)
    } finally {
      cleanup()
    }
  })

  test("returns null when work dir doesn't exist", () => {
    expect(findLatestISA("/tmp/non-existent-dir-456-xyz")).toBeNull()
  })

  test("returns null when work dir is empty", () => {
    const { root, cleanup } = stage()
    try {
      mkdirSync(workDirFor(root), { recursive: true })
      expect(findLatestISA(root)).toBeNull()
    } finally {
      cleanup()
    }
  })

  test("falls back to PRD.md within a slug when no ISA.md", () => {
    const { root, cleanup } = stage()
    try {
      const legacy = writeLegacyPrd(root, "legacy-only")
      expect(findLatestISA(root)).toBe(legacy)
    } finally {
      cleanup()
    }
  })

  test("ignores slugs that have neither ISA.md nor PRD.md", () => {
    const { root, cleanup } = stage()
    try {
      // Empty directory — should be skipped, not break the scan.
      mkdirSync(join(workDirFor(root), "empty-slug"), { recursive: true })
      const isa = writeIsa(root, "real", 5_000)
      expect(findLatestISA(root)).toBe(isa)
    } finally {
      cleanup()
    }
  })
})

describe("findProjectIsa — IsaFormat.md lines 56-57 (project ISAs)", () => {
  test("returns <root>/ISA.md when present", () => {
    const { root, cleanup } = stage()
    try {
      const expected = join(root, ARTIFACT_FILENAME)
      writeFileSync(expected, "## Goal\nproject\n", "utf8")
      expect(findProjectIsa(root)).toBe(expected)
    } finally {
      cleanup()
    }
  })

  test("returns null when no project ISA at root", () => {
    const { root, cleanup } = stage()
    try {
      expect(findProjectIsa(root)).toBeNull()
    } finally {
      cleanup()
    }
  })

  test("does NOT walk parent directories (caller passes root explicitly)", () => {
    const { root, cleanup } = stage()
    try {
      // Put an ISA at root, then look for one inside a subdir — should miss.
      writeFileSync(join(root, ARTIFACT_FILENAME), "x", "utf8")
      const sub = join(root, "subproject")
      mkdirSync(sub)
      expect(findProjectIsa(sub)).toBeNull()
    } finally {
      cleanup()
    }
  })

  test("does NOT match legacy PRD.md at root (project-ISA is canonical only)", () => {
    const { root, cleanup } = stage()
    try {
      writeFileSync(join(root, LEGACY_ARTIFACT_FILENAME), "x", "utf8")
      expect(findProjectIsa(root)).toBeNull()
    } finally {
      cleanup()
    }
  })
})

describe("isIsaFilePath — PostToolUse filter", () => {
  test("matches absolute path ending in /ISA.md", () => {
    expect(isIsaFilePath("/repo/.claude-hooks/state/work/abc/ISA.md")).toBe(true)
  })
  test("matches absolute path ending in /PRD.md (legacy)", () => {
    expect(isIsaFilePath("/repo/MEMORY/WORK/abc/PRD.md")).toBe(true)
  })
  test("matches bare 'ISA.md'", () => {
    expect(isIsaFilePath("ISA.md")).toBe(true)
  })
  test("matches bare 'PRD.md'", () => {
    expect(isIsaFilePath("PRD.md")).toBe(true)
  })
  test("does NOT match similar-looking files", () => {
    expect(isIsaFilePath("/x/ISA.md.bak")).toBe(false)
    expect(isIsaFilePath("/x/MyISA.md")).toBe(false)
    expect(isIsaFilePath("/x/PRDocs.md")).toBe(false)
  })
  test("does NOT match files with similar substring", () => {
    expect(isIsaFilePath("/x/notes-about-ISA.md")).toBe(false)
  })
  test("returns false for empty string", () => {
    expect(isIsaFilePath("")).toBe(false)
  })
  test("returns false for non-string input (defensive)", () => {
    expect(isIsaFilePath(undefined as unknown as string)).toBe(false)
    expect(isIsaFilePath(null as unknown as string)).toBe(false)
    expect(isIsaFilePath(42 as unknown as string)).toBe(false)
  })
})
