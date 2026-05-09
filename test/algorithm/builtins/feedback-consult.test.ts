import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  consultFeedback,
  feedbackDirFor,
  renderConsultBlock,
} from "../../../src/algorithm/builtins/feedback-consult.ts"

const stage = (): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "chts-feedback-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const writeMemo = (
  root: string,
  name: string,
  body: string,
  mtimeSeconds: number = Date.now() / 1000,
): string => {
  const dir = feedbackDirFor(root)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, body, "utf-8")
  utimesSync(path, mtimeSeconds, mtimeSeconds)
  return path
}

describe("feedbackDirFor", () => {
  test("path is <root>/.claude-hooks/feedback", () => {
    expect(feedbackDirFor("/tmp/x")).toBe("/tmp/x/.claude-hooks/feedback")
  })
})

describe("consultFeedback", () => {
  test("returns [] when feedback dir absent", () => {
    const { root, cleanup } = stage()
    try {
      expect(consultFeedback(["x"], { dir: feedbackDirFor(root) })).toEqual([])
    } finally {
      cleanup()
    }
  })

  test("returns [] when no keywords", () => {
    const { root, cleanup } = stage()
    try {
      writeMemo(root, "feedback_x.md", "anything")
      expect(
        consultFeedback([], { dir: feedbackDirFor(root) }),
      ).toEqual([])
      expect(
        consultFeedback(["", "  "], { dir: feedbackDirFor(root) }),
      ).toEqual([])
    } finally {
      cleanup()
    }
  })

  test("returns [] when no memos match", () => {
    const { root, cleanup } = stage()
    try {
      writeMemo(root, "feedback_a.md", "this memo is about widgets")
      expect(
        consultFeedback(["zebra"], { dir: feedbackDirFor(root) }),
      ).toEqual([])
    } finally {
      cleanup()
    }
  })

  test("matches case-insensitively", () => {
    const { root, cleanup } = stage()
    try {
      writeMemo(root, "feedback_a.md", "OAuth refresh failed last quarter")
      const r = consultFeedback(["oauth"], { dir: feedbackDirFor(root) })
      expect(r.length).toBe(1)
      expect(r[0]?.name).toBe("feedback_a.md")
    } finally {
      cleanup()
    }
  })

  test("ranks by distinct hits, then mtime desc", () => {
    const { root, cleanup } = stage()
    try {
      writeMemo(root, "feedback_old.md", "OAuth refresh notes", 1_000)
      writeMemo(
        root,
        "feedback_new.md",
        "OAuth refresh notes; database migration notes",
        2_000,
      )
      writeMemo(root, "feedback_one.md", "OAuth here", 3_000)
      const r = consultFeedback(["oauth", "database"], {
        dir: feedbackDirFor(root),
      })
      // feedback_new has 2 distinct hits → first
      // feedback_one has 1 hit, mtime 3000 → second
      // feedback_old has 1 hit, mtime 1000 → third
      expect(r[0]?.name).toBe("feedback_new.md")
      expect(r[1]?.name).toBe("feedback_one.md")
      expect(r[2]?.name).toBe("feedback_old.md")
    } finally {
      cleanup()
    }
  })

  test("excerpt is the paragraph containing first match, capped 320 chars", () => {
    const { root, cleanup } = stage()
    try {
      writeMemo(
        root,
        "feedback_a.md",
        `Intro paragraph.

Mid paragraph mentions OAuth and the refresh flow that broke.

Outro.`,
      )
      const r = consultFeedback(["oauth"], { dir: feedbackDirFor(root) })
      expect(r[0]?.excerpt).toContain("OAuth")
      expect(r[0]?.excerpt).not.toContain("Intro paragraph")
      expect(r[0]?.excerpt).not.toContain("Outro")
      expect(r[0]?.excerpt.length).toBeLessThanOrEqual(320)
    } finally {
      cleanup()
    }
  })

  test("respects maxResults cap", () => {
    const { root, cleanup } = stage()
    try {
      for (let i = 0; i < 8; i++) writeMemo(root, `feedback_${i}.md`, `xyz`)
      const r = consultFeedback(["xyz"], {
        dir: feedbackDirFor(root),
        maxResults: 3,
      })
      expect(r.length).toBe(3)
    } finally {
      cleanup()
    }
  })

  test("only .md files are scanned", () => {
    const { root, cleanup } = stage()
    try {
      writeMemo(root, "feedback_a.md", "match")
      writeFileSync(
        join(feedbackDirFor(root), "feedback_a.txt"),
        "match",
        "utf-8",
      )
      const r = consultFeedback(["match"], { dir: feedbackDirFor(root) })
      expect(r.length).toBe(1)
      expect(r[0]?.name).toBe("feedback_a.md")
    } finally {
      cleanup()
    }
  })

  test("regex metachars in keywords are escaped (not interpreted)", () => {
    const { root, cleanup } = stage()
    try {
      writeMemo(root, "feedback_a.md", "literal a.b.c here, also axbxc")
      const r = consultFeedback(["a.b.c"], { dir: feedbackDirFor(root) })
      expect(r.length).toBe(1)
      // axbxc would match if `.` were interpreted. The hit count counts
      // distinct keywords matched (substring), so the count is 1.
      expect(r[0]?.hits).toBe(1)
    } finally {
      cleanup()
    }
  })
})

describe("renderConsultBlock", () => {
  test("returns empty string for empty matches", () => {
    expect(renderConsultBlock([])).toBe("")
  })

  test("renders header + bullet per match", () => {
    const block = renderConsultBlock([
      {
        path: "/x/feedback_a.md",
        name: "feedback_a.md",
        hits: 2,
        excerpt: "first line of excerpt\nsecond line",
      },
      {
        path: "/x/feedback_b.md",
        name: "feedback_b.md",
        hits: 1,
        excerpt: "another excerpt",
      },
    ])
    expect(block).toContain("FeedbackMemoryConsult: 2 prior memo(s) match")
    expect(block).toContain("feedback_a.md (2 hits)")
    expect(block).toContain("feedback_b.md (1 hit)") // singular
    expect(block).toContain("first line of excerpt")
  })
})
