import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { NO_DECISION, SAFE_DEFAULT } from "../../src/schema/decisions.ts"

const repoRoot = path.resolve(import.meta.dir, "../..")
const srcRoot = path.join(repoRoot, "src")

const walkTs = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry)
    const stat = statSync(file)
    if (stat.isDirectory()) {
      out.push(...walkTs(file))
    } else if (file.endsWith(".ts")) {
      out.push(file)
    }
  }
  return out
}

describe("decision semantics", () => {
  test("normal no-op and failure fallback encode identically but are named separately", () => {
    expect(NO_DECISION).toEqual({})
    expect(SAFE_DEFAULT).toEqual({})
  })

  test("SAFE_DEFAULT remains reserved for dispatcher fallback paths", () => {
    const allowed = new Set([
      path.join(srcRoot, "dispatcher.ts"),
      path.join(srcRoot, "schema", "decisions.ts"),
    ])

    const offenders = walkTs(srcRoot).flatMap((file) => {
      if (allowed.has(file)) return []
      const text = readFileSync(file, "utf8")
      return /\bSAFE_DEFAULT\b/.test(text) ? [path.relative(repoRoot, file)] : []
    })

    expect(offenders).toEqual([])
  })
})
