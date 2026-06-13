/** Skeptic drift check (BUILD-SPEC §3, constitution §6.2). */
import { spawnSync } from "node:child_process"

export function globToRegex(glob: string): RegExp {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++ }
      else re += "[^/]*"
    } else if (".+?^${}()|[]\\".includes(c)) re += `\\${c}`
    else re += c
  }
  return new RegExp(`^${re}$`)
}

export function parsePorcelainZ(raw: string): string[] {
  const recs = raw.split("\0").filter((r) => r.length > 0)
  const out: string[] = []
  let skip = false
  for (const rec of recs) {
    if (skip) { skip = false; continue }
    if (rec.length > 3 && rec[2] === " ") { out.push(rec.slice(3)); if (rec[0] === "R" || rec[0] === "C") skip = true }
    else out.push(rec)
  }
  return out
}

export interface DriftResult { verdict: "none" | "detected" | "skipped"; changed: string[]; detail: string }

export function checkDrift(workspace: string, ignore: string[], exempt: string[]): DriftResult {
  const r = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: workspace, encoding: "utf8", timeout: 10_000 })
  if (r.error || r.status !== 0) return { verdict: "skipped", changed: [], detail: `git status failed` }
  const igns = ignore.map(globToRegex)
  const ex = new Set(exempt)
  const residual = parsePorcelainZ(r.stdout).filter((p) => !ex.has(p) && !igns.some((re) => re.test(p)))
  if (residual.length === 0) return { verdict: "none", changed: [], detail: "clean" }
  return { verdict: "detected", changed: residual.slice(0, 50), detail: `${residual.length} changed` }
}
