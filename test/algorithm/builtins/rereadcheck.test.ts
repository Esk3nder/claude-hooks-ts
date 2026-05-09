import { describe, expect, test } from "bun:test"
import {
  extractExplicitAsks,
  rereadCheck,
} from "../../../src/algorithm/builtins/rereadcheck.ts"

describe("extractExplicitAsks", () => {
  test("extracts imperative-verb sentences", () => {
    const asks = extractExplicitAsks(
      "Add the new endpoint. Fix the typo on line 12. Then run tests.",
    )
    expect(asks.length).toBe(3)
    expect(asks.every((a) => a.kind === "imperative")).toBe(true)
  })

  test("extracts question sentences", () => {
    const asks = extractExplicitAsks("What is the auth flow? How does X work?")
    expect(asks.length).toBe(2)
    expect(asks.every((a) => a.kind === "question")).toBe(true)
  })

  test("extracts numbered list items", () => {
    const asks = extractExplicitAsks(
      "Do these:\n1. First thing\n2. Second thing\n3. Third thing\n",
    )
    expect(asks.length).toBeGreaterThanOrEqual(3)
    const items = asks.filter((a) => a.kind === "list-item")
    expect(items.length).toBe(3)
  })

  test("extracts bulleted list items", () => {
    const asks = extractExplicitAsks(
      "Do these:\n- A\n- B\n* C\n",
    )
    expect(asks.filter((a) => a.kind === "list-item").length).toBe(3)
  })

  test("dedupes identical asks", () => {
    const asks = extractExplicitAsks("Add foo. Add foo.")
    expect(asks.length).toBe(1)
  })

  test("returns empty for prose with no asks", () => {
    expect(extractExplicitAsks("nice work yesterday").length).toBe(0)
  })

  test("indices start at 1 and increase", () => {
    const asks = extractExplicitAsks("Add A. Fix B?")
    expect(asks[0]?.index).toBe(1)
    expect(asks[1]?.index).toBe(2)
  })
})

describe("rereadCheck", () => {
  test("ok when every ask noun appears in draft", () => {
    const r = rereadCheck(
      "Add the OAuth refresh flow. Fix the timeout bug.",
      "I implemented the OAuth refresh flow and fixed the timeout bug. Done.",
    )
    expect(r.ok).toBe(true)
    expect(r.unmet).toEqual([])
  })

  test("flags an ask whose noun is absent from the draft", () => {
    const r = rereadCheck(
      "Add the OAuth flow. Update the README.",
      "I added the OAuth flow.",
    )
    expect(r.ok).toBe(false)
    expect(r.unmet.length).toBe(1)
    expect(r.unmet[0]?.text).toContain("README")
  })

  test("flags multiple unmet asks in order", () => {
    const r = rereadCheck(
      "Add A. Fix B. Update C.",
      "I just added A.",
    )
    // Only A's mention works; B and C unmet. But "added" is an ack token,
    // and "A" is too short (< 4 chars) to be a noun-ish word. So extraction
    // for "Add A" is by exact-substring fallback. Let's use bigger nouns.
    void r
    const r2 = rereadCheck(
      "Add the auth module. Fix the database. Update the README.",
      "I just added the auth module.",
    )
    expect(r2.ok).toBe(false)
    expect(r2.unmet.length).toBe(2)
    expect(r2.unmet.map((u) => u.text).join(" ")).toContain("database")
    expect(r2.unmet.map((u) => u.text).join(" ")).toContain("README")
  })

  test("question-form ask covered by topic mention + ack-style draft", () => {
    const r = rereadCheck(
      "What is the auth flow?",
      "Done. The auth flow uses OAuth. Auth flow is documented here.",
    )
    expect(r.ok).toBe(true)
  })

  test("message empty when ok", () => {
    const r = rereadCheck("Add foo bar.", "I added the foo bar feature. Done.")
    expect(r.message).toBe("")
  })

  test("message describes unmet asks when not ok", () => {
    const r = rereadCheck(
      "Add the OAuth refresh flow. Update the README.",
      "I added OAuth refresh.", // README missing
    )
    expect(r.message).toContain("ReReadCheck")
    expect(r.message).toContain("unaddressed")
    expect(r.message).toContain("README")
  })

  test("message excerpt truncated to 80 chars per ask", () => {
    const longAsk = "Add " + "x".repeat(200) + "."
    const r = rereadCheck(longAsk, "draft text")
    expect(r.message).toContain("...")
  })

  test("empty prompt → ok with no asks", () => {
    const r = rereadCheck("", "anything")
    expect(r.asks).toEqual([])
    expect(r.ok).toBe(true)
  })

  test("empty draft → unmet equals all asks", () => {
    const r = rereadCheck("Add the database migration.", "")
    expect(r.ok).toBe(false)
    expect(r.unmet.length).toBe(1)
  })
})
