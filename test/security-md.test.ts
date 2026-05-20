/**
 * P0-3 — SECURITY.md reference validity.
 *
 * SECURITY.md cites concrete `file:line` locations as evidence for each
 * mitigation claim. A future refactor that moves those lines without
 * updating the doc would silently invalidate the audit trail. This
 * test parses every `<path>:<line>` reference in SECURITY.md and
 * asserts the file exists AND the line number is within its line
 * count. Catches drift before it lands.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const SECURITY_MD = resolve(REPO_ROOT, "SECURITY.md")

const REQUIRED_SECTIONS = [
  "## Reporting a vulnerability",
  "## Scope",
  "## Trust boundaries",
  "## Threat model",
  "## Mitigations",
  "## Known gaps",
  "## Out of scope",
] as const

/** Path-like token followed by `:<line>`. */
const REF_RE = /(?:src|scripts|bin|test)\/[\w./-]+\.(?:ts|yaml|yml)(?::(\d+(?:-\d+)?))/g

describe("SECURITY.md (P0-3)", () => {
  test("exists at repo root", () => {
    expect(() => readFileSync(SECURITY_MD, "utf8")).not.toThrow()
  })

  test("contains all required H2 sections", () => {
    const body = readFileSync(SECURITY_MD, "utf8")
    for (const section of REQUIRED_SECTIONS) {
      expect(body).toContain(section)
    }
  })

  test("every file:line reference resolves to a real path + valid line", () => {
    const body = readFileSync(SECURITY_MD, "utf8")
    const matches = [...body.matchAll(REF_RE)]
    expect(matches.length).toBeGreaterThanOrEqual(10) // ISC-3 lower bound

    const seen = new Set<string>()
    for (const m of matches) {
      const full = m[0]
      // Split off the line / range:
      const lastColon = full.lastIndexOf(":")
      const filePart = full.slice(0, lastColon)
      const rangePart = full.slice(lastColon + 1)
      // dedupe so a single citation isn't checked N times unnecessarily
      const key = `${filePart}@${rangePart}`
      if (seen.has(key)) continue
      seen.add(key)

      const fileAbs = resolve(REPO_ROOT, filePart)
      let body: string
      try {
        body = readFileSync(fileAbs, "utf8")
      } catch {
        throw new Error(
          `SECURITY.md cites ${filePart}:${rangePart} but the file does not exist on disk`,
        )
      }
      const lineCount = body.split("\n").length
      // Range form `123-456` — assert both endpoints are within file
      const parts = rangePart.split("-").map((s) => Number.parseInt(s, 10))
      for (const n of parts) {
        expect(n).toBeGreaterThan(0)
        expect(n).toBeLessThanOrEqual(lineCount)
      }
    }
  })

  test("Mitigations section names at least 10 distinct file references", () => {
    const body = readFileSync(SECURITY_MD, "utf8")
    const mitigationsStart = body.indexOf("## Mitigations")
    const mitigationsEnd = body.indexOf("## Known gaps")
    expect(mitigationsStart).toBeGreaterThan(0)
    expect(mitigationsEnd).toBeGreaterThan(mitigationsStart)
    const section = body.slice(mitigationsStart, mitigationsEnd)
    const refs = new Set<string>()
    for (const m of section.matchAll(REF_RE)) {
      refs.add(m[0].slice(0, m[0].lastIndexOf(":")))
    }
    expect(refs.size).toBeGreaterThanOrEqual(10)
  })

  test("Known gaps section names US-23 and the three P0 enforcement-plane bypasses", () => {
    const body = readFileSync(SECURITY_MD, "utf8")
    const gapsStart = body.indexOf("## Known gaps")
    const gapsEnd = body.indexOf("## Out of scope")
    expect(gapsStart).toBeGreaterThan(0)
    const section = body.slice(gapsStart, gapsEnd)
    expect(section).toContain("US-23")
    expect(section).toContain("`Update`")
    expect(section).toContain("`NotebookEdit`")
    expect(section).toContain("MCP")
    expect(section).toContain("heredoc")
  })

  test("README links to SECURITY.md", () => {
    const readme = readFileSync(resolve(REPO_ROOT, "README.md"), "utf8")
    expect(readme).toContain("SECURITY.md")
  })
})
