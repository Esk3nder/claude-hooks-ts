import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getRecentContext } from "../../src/algorithm/transcript-context.ts"

const writeTranscript = (
  root: string,
  entries: ReadonlyArray<unknown>,
): string => {
  const file = join(root, "transcript.jsonl")
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n"), "utf8")
  return file
}

describe("getRecentContext — the upstream classifier verbatim port", () => {
  test("returns '' when transcript_path is undefined", () => {
    expect(getRecentContext(undefined)).toBe("")
  })
  test("returns '' when file does not exist", () => {
    expect(getRecentContext("/nonexistent/path.jsonl")).toBe("")
  })

  test("extracts string-content user turns", () => {
    const root = mkdtempSync(join(tmpdir(), "ctx-"))
    try {
      const file = writeTranscript(root, [
        { type: "user", message: { content: "fix the bug" } },
      ])
      expect(getRecentContext(file)).toBe("User: fix the bug")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("extracts array-content user turns (text type)", () => {
    const root = mkdtempSync(join(tmpdir(), "ctx-"))
    try {
      const file = writeTranscript(root, [
        {
          type: "user",
          message: {
            content: [
              { type: "text", text: "first" },
              { type: "text", text: "second" },
            ],
          },
        },
      ])
      expect(getRecentContext(file)).toBe("User: first second")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("includes assistant turns by default (changed from the upstream default)", () => {
    const root = mkdtempSync(join(tmpdir(), "ctx-"))
    try {
      const file = writeTranscript(root, [
        { type: "user", message: { content: "do the work" } },
        { type: "assistant", message: { content: "proposed plan A B C" } },
        { type: "user", message: { content: "yes" } },
      ])
      const out = getRecentContext(file)
      expect(out).toContain("User: do the work")
      expect(out).toContain("Assistant: proposed plan A B C")
      expect(out).toContain("User: yes")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("respects maxTurns", () => {
    const root = mkdtempSync(join(tmpdir(), "ctx-"))
    try {
      const entries = []
      for (let i = 0; i < 10; i++) {
        entries.push({ type: "user", message: { content: `turn ${i}` } })
      }
      const file = writeTranscript(root, entries)
      const out = getRecentContext(file, 3)
      expect(out.split("\n").length).toBe(3)
      expect(out).toContain("turn 7")
      expect(out).toContain("turn 9")
      expect(out).not.toContain("turn 5")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("user content sliced to 200 chars", () => {
    const root = mkdtempSync(join(tmpdir(), "ctx-"))
    try {
      const file = writeTranscript(root, [
        { type: "user", message: { content: "x".repeat(500) } },
      ])
      const out = getRecentContext(file)
      // "User: " prefix (6 chars) + 200 chars of x = 206
      expect(out.length).toBe(206)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("assistant content sliced to 150 chars OR SUMMARY: snippet", () => {
    const root = mkdtempSync(join(tmpdir(), "ctx-"))
    try {
      const file = writeTranscript(root, [
        {
          type: "assistant",
          message: { content: "rambling intro\nSUMMARY: did the thing\nmore prose" },
        },
      ])
      const out = getRecentContext(file)
      // the spec captures `[^\n]+` after `SUMMARY:\s*` → trimmed snippet.
      expect(out).toBe("Assistant: did the thing")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("skips per-line parse errors gracefully", () => {
    const root = mkdtempSync(join(tmpdir(), "ctx-"))
    try {
      const file = join(root, "transcript.jsonl")
      writeFileSync(
        file,
        [
          JSON.stringify({ type: "user", message: { content: "before" } }),
          "{not valid json",
          JSON.stringify({ type: "user", message: { content: "after" } }),
        ].join("\n"),
        "utf8",
      )
      const out = getRecentContext(file)
      expect(out).toContain("before")
      expect(out).toContain("after")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("returns '' when transcript has no usable turns", () => {
    const root = mkdtempSync(join(tmpdir(), "ctx-"))
    try {
      const file = writeTranscript(root, [
        { type: "system", message: { content: "ignored" } },
      ])
      expect(getRecentContext(file)).toBe("")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("B1 fix: array content with {type:'text'} but no text field does NOT leak 'undefined'", () => {
    const root = mkdtempSync(join(tmpdir(), "ctx-"))
    try {
      const file = writeTranscript(root, [
        {
          type: "user",
          message: {
            content: [
              { type: "text" }, // missing text field
              { type: "text", text: "real text" },
            ],
          },
        },
      ])
      const out = getRecentContext(file)
      // Pre-fix bug: filter let {type:"text"} through, .map(c=>c.text) →
      // [undefined, "real text"], join → "undefined real text".
      // Post-fix: predicate also requires typeof text === "string".
      expect(out).not.toContain("undefined")
      expect(out).toBe("User: real text")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("B1 fix: assistant content with malformed text entries also filtered", () => {
    const root = mkdtempSync(join(tmpdir(), "ctx-"))
    try {
      const file = writeTranscript(root, [
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: 42 }, // wrong type
              { type: "text", text: "good text" },
            ],
          },
        },
      ])
      const out = getRecentContext(file)
      expect(out).not.toContain("42")
      expect(out).toContain("good text")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
