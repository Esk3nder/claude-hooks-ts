import { describe, expect, test } from "bun:test"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  allowlistPathFor,
  expandPath,
  isGitRepo,
  hasChanges,
  loadAllowlist,
  loadState,
  newlyCompletedISCs,
  runCheckpoint,
  sanitizeMessage,
  saveState,
  STATE_FILENAME,
  commitInRepo,
} from "../../../src/algorithm/isa/checkpoint.ts"
import type { CriterionEntry } from "../../../src/algorithm/isa/criteria.ts"
import { ARTIFACT_FILENAME } from "../../../src/algorithm/isa/locate.ts"

interface Staged {
  readonly root: string
  readonly cleanup: () => void
}

const stage = (): Staged => {
  const root = mkdtempSync(join(tmpdir(), "chts-checkpoint-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const initGitRepo = (path: string): void => {
  mkdirSync(path, { recursive: true })
  execFileSync("git", ["-C", path, "init", "--quiet", "-b", "main"], {
    stdio: "ignore",
  })
  execFileSync(
    "git",
    ["-C", path, "config", "user.email", "test@example.com"],
    { stdio: "ignore" },
  )
  execFileSync("git", ["-C", path, "config", "user.name", "Test"], {
    stdio: "ignore",
  })
  execFileSync("git", ["-C", path, "config", "commit.gpgsign", "false"], {
    stdio: "ignore",
  })
}

const writeAllowlist = (root: string, contents: string): void => {
  const path = allowlistPathFor(root)
  mkdirSync(join(root, ".claude-hooks"), { recursive: true })
  writeFileSync(path, contents, "utf-8")
}

const c = (
  id: string,
  description: string,
  status: "pending" | "completed" = "pending",
): CriterionEntry => ({
  id,
  description,
  status,
  type: "criterion",
})

describe("expandPath — the classifier mirror", () => {
  const home = process.env["HOME"] ?? ""
  test("expands ~/foo to $HOME/foo", () => {
    expect(expandPath("~/foo/bar")).toBe(join(home, "foo/bar"))
  })
  test("expands bare ~ to $HOME", () => {
    expect(expandPath("~")).toBe(home)
  })
  test("expands $HOME prefix with /", () => {
    expect(expandPath("$HOME/x")).toBe(`${home}/x`)
  })
  test("expands bare $HOME to $HOME", () => {
    expect(expandPath("$HOME")).toBe(home)
  })
  test("trims surrounding whitespace", () => {
    expect(expandPath(" /tmp/x ")).toBe("/tmp/x")
  })
  test("returns empty for empty / whitespace input", () => {
    expect(expandPath("")).toBe("")
    expect(expandPath(" ")).toBe("")
  })
  test("leaves an absolute path untouched", () => {
    expect(expandPath("/tmp/y")).toBe("/tmp/y")
  })
})

describe("loadAllowlist — the classifier mirror", () => {
  test("returns [] when allowlist file absent (default install)", () => {
    const { root, cleanup } = stage()
    try {
      expect(loadAllowlist(root)).toEqual([])
    } finally {
      cleanup()
    }
  })

  test("reads non-empty entries, ignores comments and blanks", () => {
    const { root, cleanup } = stage()
    try {
      writeAllowlist(
        root,
        `# this is a comment
/tmp/repo-a

/tmp/repo-b
 # leading-ws comment

/tmp/repo-c
`,
      )
      expect(loadAllowlist(root)).toEqual([
        "/tmp/repo-a",
        "/tmp/repo-b",
        "/tmp/repo-c",
      ])
    } finally {
      cleanup()
    }
  })

  test("expands ~ and $HOME inside entries", () => {
    const home = process.env["HOME"] ?? ""
    const { root, cleanup } = stage()
    try {
      writeAllowlist(root, `~/Projects/foo\n$HOME/bar\n`)
      expect(loadAllowlist(root)).toEqual([
        join(home, "Projects/foo"),
        `${home}/bar`,
      ])
    } finally {
      cleanup()
    }
  })
})

describe("sanitizeMessage — the classifier", () => {
  test("collapses whitespace, strips backticks/$, trims, caps at 200", () => {
    expect(sanitizeMessage(" hello world ")).toBe("hello world")
    expect(sanitizeMessage("`evil` and $injection")).toBe("evil and injection")
    expect(sanitizeMessage("a".repeat(500)).length).toBe(200)
  })
  test("multi-line input collapses to single line", () => {
    expect(sanitizeMessage("line1\nline2\nline3")).toBe("line1 line2 line3")
  })
})

describe("loadState / saveState round-trip", () => {
  test("missing file returns empty state", () => {
    const { root, cleanup } = stage()
    try {
      const f = join(root, "missing.json")
      expect(loadState(f)).toEqual({
        committed_iscs: [],
        last_commit_sha: {},
      })
    } finally {
      cleanup()
    }
  })

  test("malformed JSON resets to empty (not throws)", () => {
    const { root, cleanup } = stage()
    try {
      const f = join(root, "broken.json")
      writeFileSync(f, "{not valid", "utf-8")
      expect(loadState(f)).toEqual({
        committed_iscs: [],
        last_commit_sha: {},
      })
    } finally {
      cleanup()
    }
  })

  test("save then load preserves committed_iscs and shas", () => {
    const { root, cleanup } = stage()
    try {
      const f = join(root, "state.json")
      saveState(f, {
        committed_iscs: ["ISC-1", "ISC-2"],
        last_commit_sha: { "/tmp/repo-a": "abc123" },
      })
      const loaded = loadState(f)
      expect(loaded.committed_iscs).toEqual(["ISC-1", "ISC-2"])
      expect(loaded.last_commit_sha["/tmp/repo-a"]).toBe("abc123")
    } finally {
      cleanup()
    }
  })

  test("filters non-string entries from committed_iscs (defensive)", () => {
    const { root, cleanup } = stage()
    try {
      const f = join(root, "weird.json")
      writeFileSync(
        f,
        JSON.stringify({
          committed_iscs: ["ISC-1", 42, null, "ISC-2"],
          last_commit_sha: {},
        }),
        "utf-8",
      )
      expect(loadState(f).committed_iscs).toEqual(["ISC-1", "ISC-2"])
    } finally {
      cleanup()
    }
  })
})

describe("newlyCompletedISCs — pure planner", () => {
  test("returns ISCs that are completed but not in state", () => {
    const criteria = [
      c("ISC-1", "a", "completed"),
      c("ISC-2", "b", "pending"),
      c("ISC-3", "c", "completed"),
    ]
    const result = newlyCompletedISCs(criteria, {
      committed_iscs: ["ISC-1"],
      last_commit_sha: {},
    })
    expect(result.map((x) => x.id)).toEqual(["ISC-3"])
  })

  test("returns [] when no transitions", () => {
    expect(
      newlyCompletedISCs([c("ISC-1", "a", "completed")], {
        committed_iscs: ["ISC-1"],
        last_commit_sha: {},
      }),
    ).toEqual([])
  })

  test("returns [] when nothing completed", () => {
    expect(
      newlyCompletedISCs([c("ISC-1", "a", "pending")], {
        committed_iscs: [],
        last_commit_sha: {},
      }),
    ).toEqual([])
  })
})

describe("isGitRepo / hasChanges — the classifier", () => {
  test("isGitRepo true on initialized repo", () => {
    const { root, cleanup } = stage()
    try {
      const repo = join(root, "git-repo")
      initGitRepo(repo)
      expect(isGitRepo(repo)).toBe(true)
    } finally {
      cleanup()
    }
  })

  test("isGitRepo false on plain dir", () => {
    const { root, cleanup } = stage()
    try {
      mkdirSync(join(root, "plain"))
      expect(isGitRepo(join(root, "plain"))).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("hasChanges false on freshly-initialized empty repo", () => {
    const { root, cleanup } = stage()
    try {
      const repo = join(root, "empty-repo")
      initGitRepo(repo)
      expect(hasChanges(repo)).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("hasChanges true when an untracked file is present", () => {
    const { root, cleanup } = stage()
    try {
      const repo = join(root, "dirty-repo")
      initGitRepo(repo)
      writeFileSync(join(repo, "x.txt"), "hi", "utf-8")
      expect(hasChanges(repo)).toBe(true)
    } finally {
      cleanup()
    }
  })
})

describe("commitInRepo end-to-end", () => {
  test("creates a commit with sanitized subject; returns SHA", () => {
    const { root, cleanup } = stage()
    try {
      const repo = join(root, "live-repo")
      initGitRepo(repo)
      writeFileSync(join(repo, "f.txt"), "content", "utf-8")
      const sha = commitInRepo(repo, "ISC-7", "20260509_x", " did the\nthing ")
      expect(sha).not.toBeNull()
      const log = execFileSync(
        "git",
        ["-C", repo, "log", "-1", "--pretty=%s"],
        { encoding: "utf-8" },
      ).trim()
      expect(log).toBe("ISC-7 (20260509_x): did the thing")
    } finally {
      cleanup()
    }
  })

  test("returns null and logs when there's nothing to commit", () => {
    const { root, cleanup } = stage()
    try {
      const repo = join(root, "clean-repo")
      initGitRepo(repo)
      // No changes — `git commit` should fail.
      expect(commitInRepo(repo, "ISC-1", "slug", "msg")).toBeNull()
    } finally {
      cleanup()
    }
  })
})

describe("runCheckpoint — top-level orchestrator", () => {
  const isaContents = (criteriaBlock: string): string => `---
task: x
slug: 20260509_x
phase: build
---

## Goal
ship

## Criteria
${criteriaBlock}
`

  test("skipped: missing-file when ISA doesn't exist", () => {
    const r = runCheckpoint("/tmp/non-existent-isa-xyz.md")
    expect(r.skipped).toBe("missing-file")
    expect(r.commits).toEqual([])
  })

  test("skipped: no-frontmatter when ISA has no frontmatter", () => {
    const { root, cleanup } = stage()
    try {
      const isaDir = join(root, ".claude-hooks", "state", "work", "slug")
      mkdirSync(isaDir, { recursive: true })
      const isa = join(isaDir, ARTIFACT_FILENAME)
      writeFileSync(isa, "## Criteria\n- [x] ISC-1: x\n", "utf-8")
      const r = runCheckpoint(isa, root)
      expect(r.skipped).toBe("no-frontmatter")
    } finally {
      cleanup()
    }
  })

  test("skipped: no-criteria when ISA has no Criteria section", () => {
    const { root, cleanup } = stage()
    try {
      const isaDir = join(root, ".claude-hooks", "state", "work", "slug")
      mkdirSync(isaDir, { recursive: true })
      const isa = join(isaDir, ARTIFACT_FILENAME)
      writeFileSync(isa, `---\ntask: x\n---\n\n## Goal\nx\n`, "utf-8")
      const r = runCheckpoint(isa, root)
      expect(r.skipped).toBe("no-criteria")
    } finally {
      cleanup()
    }
  })

  test("skipped: no-allowlist when allowlist is empty (default install)", () => {
    const { root, cleanup } = stage()
    try {
      const isaDir = join(root, ".claude-hooks", "state", "work", "slug")
      mkdirSync(isaDir, { recursive: true })
      const isa = join(isaDir, ARTIFACT_FILENAME)
      writeFileSync(isa, isaContents("- [x] ISC-1: did x"), "utf-8")
      const r = runCheckpoint(isa, root)
      expect(r.skipped).toBe("no-allowlist")
      expect(r.commits).toEqual([])
    } finally {
      cleanup()
    }
  })

  test("happy path: creates one commit per repo for each newly-checked ISC", () => {
    const { root, cleanup } = stage()
    try {
      const repo = join(root, "repo-a")
      initGitRepo(repo)
      writeFileSync(join(repo, "f.txt"), "v1", "utf-8")
      writeAllowlist(root, `${repo}\n`)

      const slug = "20260509_demo"
      const isaDir = join(root, ".claude-hooks", "state", "work", slug)
      mkdirSync(isaDir, { recursive: true })
      const isa = join(isaDir, ARTIFACT_FILENAME)
      writeFileSync(isa, isaContents("- [x] ISC-1: did the thing"), "utf-8")

      const r = runCheckpoint(isa, root)
      expect(r.skipped).toBeNull()
      expect(r.iscIds).toEqual(["ISC-1"])
      expect(r.commits.length).toBe(1)
      expect(r.commits[0]?.iscId).toBe("ISC-1")
      expect(r.commits[0]?.repo).toBe(repo)

      // Sidecar state file persisted
      const stateFile = join(isaDir, STATE_FILENAME)
      expect(existsSync(stateFile)).toBe(true)
      const state = JSON.parse(readFileSync(stateFile, "utf-8")) as {
        committed_iscs: string[]
      }
      expect(state.committed_iscs).toContain("ISC-1")
    } finally {
      cleanup()
    }
  })

  test("idempotent: second run with same state does nothing", () => {
    const { root, cleanup } = stage()
    try {
      const repo = join(root, "repo-b")
      initGitRepo(repo)
      writeFileSync(join(repo, "f.txt"), "v1", "utf-8")
      writeAllowlist(root, `${repo}\n`)

      const slug = "20260509_idem"
      const isaDir = join(root, ".claude-hooks", "state", "work", slug)
      mkdirSync(isaDir, { recursive: true })
      const isa = join(isaDir, ARTIFACT_FILENAME)
      writeFileSync(isa, isaContents("- [x] ISC-1: a"), "utf-8")

      const first = runCheckpoint(isa, root)
      expect(first.commits.length).toBe(1)

      // No new changes → second run produces no commits.
      const second = runCheckpoint(isa, root)
      expect(second.commits.length).toBe(0)
      expect(second.iscIds).toEqual([])
    } finally {
      cleanup()
    }
  })

  test("missing repo in allowlist is logged and skipped, not fatal", () => {
    const { root, cleanup } = stage()
    try {
      writeAllowlist(root, `/tmp/this-repo-does-not-exist-xyz-123\n`)
      const slug = "miss"
      const isaDir = join(root, ".claude-hooks", "state", "work", slug)
      mkdirSync(isaDir, { recursive: true })
      const isa = join(isaDir, ARTIFACT_FILENAME)
      writeFileSync(isa, isaContents("- [x] ISC-1: a"), "utf-8")
      const r = runCheckpoint(isa, root)
      expect(r.skipped).toBeNull()
      expect(r.commits.length).toBe(0)
      // ISC still recorded in state — won't try to commit it again.
      const state = loadState(join(isaDir, STATE_FILENAME))
      expect(state.committed_iscs).toContain("ISC-1")
    } finally {
      cleanup()
    }
  })
})
