import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { briefsDir } from "../briefs.ts"
import { policyPath } from "../config.ts"
import { handleSessionStart } from "../dispatch.ts"
import type { WorkerBrief } from "../types.ts"
import type { PolicyConfig } from "../config.ts"

export function gitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "chf-"))
  spawnSync("git", ["init", "-q"], { cwd: dir })
  writeFileSync(join(dir, "README.md"), "x\n")
  spawnSync("git", ["add", "-A"], { cwd: dir })
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: dir })
  return dir
}

export function writePolicy(project: string, p: Partial<PolicyConfig>): void {
  mkdirSync(join(project, ".claude-hooks"), { recursive: true })
  writeFileSync(policyPath(project), JSON.stringify({ schema_version: 1, ...p }))
}

export function registerBrief(project: string, b: WorkerBrief): void {
  mkdirSync(briefsDir(project), { recursive: true })
  writeFileSync(join(briefsDir(project), `${b.label}.json`), JSON.stringify(b))
}

export function startSession(project: string, sessionId: string): void {
  handleSessionStart(project, sessionId)
}

export function implResult(label: string, root: string, argv: string[], status: "done" | "blocked" = "done") {
  if (status === "blocked") return JSON.stringify({ label, status: "blocked", summary: "blocked", workspace: { root }, changed_files: [], blockers: ["scope"] })
  return JSON.stringify({
    label, status: "done", summary: "did it", workspace: { root, base_ref: "abc", isolation: "shared" },
    changed_files: ["src/x.ts"], verification: { argv, cwd: ".", exit_code: 0, output_tail: "" }, blockers: [],
  })
}
