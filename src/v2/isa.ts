/**
 * ISA discovery + parse for the evidential completion gate (SPEC §6.4, BUILD-SPEC §3.2).
 * Standalone, zero-dep mirror of the artifact convention in src/algorithm/isa/
 * (locate.ts / frontmatter.ts / criteria.ts) — v2 does not depend on the Effect modules.
 * Only the read surface the gate needs: where the active ISA lives, its `phase:`, and the
 * ids declared under `## Criteria`. Writers/ledger are out of scope here.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stateRoot } from "./fsx.ts"

const ARTIFACT = "ISA.md"

export interface ActiveIsa {
  path: string
  phase: string | null
  iscs: string[]
}

/** Flat-frontmatter `phase:` value (quotes stripped), or null when absent. */
function parsePhase(content: string): string | null {
  const m = content.match(/^---\n([\s\S]*?)\n---/)
  if (!m || m[1] === undefined) return null
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":")
    if (i > 0 && line.slice(0, i).trim() === "phase") return line.slice(i + 1).trim().replace(/^["']|["']$/g, "")
  }
  return null
}

/**
 * Declared ISC ids from the `## Criteria` / `## ISC Criteria` / `## IDEAL STATE CRITERIA`
 * section. Checkbox lines only (`- [ ] <ID>: …` / `- [x] <ID>: …`); the leading token is the
 * id. Permissive on id shape (`ISC1`, `ISC-1`, `ISC-CLI-3`) so it matches both legacy ISAs and
 * v2 brief.isc_id values. Section ends at the next H2, a `---`, or EOF.
 */
export function parseCriteriaIds(content: string): string[] {
  const head = /^(?:##\s+(?:ISC\s+)?Criteria\b[^\n]*|##\s+IDEAL\s+STATE\s+CRITERIA\b[^\n]*)$/im.exec(content)
  if (!head || head.index === undefined) return []
  const rest = content.slice(head.index + head[0].length)
  const end = rest.match(/\n##\s+(?!#)|\n---\s*\n/)
  const body = end ? rest.slice(0, end.index) : rest
  const ids: string[] = []
  for (const line of body.split("\n")) {
    const m = line.match(/^- \[[ x]\]\s*([A-Za-z][\w-]*)\b/)
    if (m && m[1]) ids.push(m[1])
  }
  return ids
}

function readIsa(path: string): ActiveIsa | null {
  let content: string
  try { content = readFileSync(path, "utf8") } catch { return null }
  return { path, phase: parsePhase(content), iscs: parseCriteriaIds(content) }
}

/** Most-recently-modified `.claude-hooks/work/<slug>/ISA.md`, or null. (Never scans archive/.) */
function latestWorkIsa(project: string): string | null {
  const dir = join(stateRoot(project), "work")
  if (!existsSync(dir)) return null
  let latest: string | null = null
  let mt = 0
  try {
    for (const slug of readdirSync(dir)) {
      const c = join(dir, slug, ARTIFACT)
      try { const s = statSync(c); if (s.isFile() && s.mtimeMs > mt) { mt = s.mtimeMs; latest = c } } catch { /* skip */ }
    }
  } catch { /* none */ }
  return latest
}

/**
 * Locate the ISA that binds this session, by the documented convention:
 *   1. session work ISA  `.claude-hooks/work/<session>/ISA.md`
 *   2. project ISA       `<repo>/ISA.md`
 *   3. newest work-dir ISA across slugs
 * Returns null when no ISA exists (⇒ the evidential gate does not bind).
 */
export function findActiveIsa(project: string, session: string): ActiveIsa | null {
  const direct = [join(stateRoot(project), "work", session, ARTIFACT), join(project, ARTIFACT)]
  const path = direct.find((c) => existsSync(c)) ?? latestWorkIsa(project)
  return path === null ? null : readIsa(path)
}
