import { describe, expect, test } from "bun:test"
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

const SCRIPT = new URL("../../scripts/init.ts", import.meta.url).pathname

interface Run {
 readonly stdout: string
 readonly stderr: string
 readonly exitCode: number
}

const runInit = async (
 cwd: string,
 flags: ReadonlyArray<string> = [],
 env: Record<string, string> = {},
): Promise<Run> => {
 const proc = Bun.spawn(["bun", "run", SCRIPT, "--cwd", cwd, ...flags], {
 stdout: "pipe",
 stderr: "pipe",
 env: { ...process.env, ...env },
 })
 const [stdout, stderr] = await Promise.all([
 new Response(proc.stdout as ReadableStream).text(),
 new Response(proc.stderr as ReadableStream).text(),
 ])
 const exitCode = await proc.exited
 return { stdout, stderr, exitCode: typeof exitCode === "number" ? exitCode : -1 }
}

const stage = (): { root: string; cleanup: () => void } => {
 const root = mkdtempSync(join(tmpdir(), "chts-init-"))
 return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe("claude-hooks-init", () => {
 test("default run creates .claude-hooks/state/", async () => {
 const { root, cleanup } = stage()
 try {
 const r = await runInit(root)
 expect(r.exitCode).toBe(0)
 expect(existsSync(join(root, ".claude-hooks", "state"))).toBe(true)
 expect(r.stdout).toContain("[ok]")
 } finally {
 cleanup()
 }
 })

 test("--print never writes", async () => {
 const { root, cleanup } = stage()
 try {
 const r = await runInit(root, ["--regenerate", "--print"])
 expect(r.exitCode).toBe(0)
 expect(r.stdout).toContain("[print]")
 expect(existsSync(join(root, ".claude-hooks", "regenerate.yaml"))).toBe(false)
 } finally {
 cleanup()
 }
 })

 test("--regenerate writes starter yaml", async () => {
 const { root, cleanup } = stage()
 try {
 const r = await runInit(root, ["--regenerate"])
 expect(r.exitCode).toBe(0)
 const target = join(root, ".claude-hooks", "regenerate.yaml")
 expect(existsSync(target)).toBe(true)
 const body = readFileSync(target, "utf-8")
 expect(body).toContain("rules: []")
 } finally {
 cleanup()
 }
 })

 test("--regenerate skips when file exists (idempotent)", async () => {
 const { root, cleanup } = stage()
 try {
 mkdirSync(join(root, ".claude-hooks"), { recursive: true })
 writeFileSync(
 join(root, ".claude-hooks", "regenerate.yaml"),
 "user content",
 "utf-8",
 )
 const r = await runInit(root, ["--regenerate"])
 expect(r.exitCode).toBe(0)
 expect(r.stdout).toContain("(exists)")
 // Original content untouched
 expect(
 readFileSync(join(root, ".claude-hooks", "regenerate.yaml"), "utf-8"),
 ).toBe("user content")
 } finally {
 cleanup()
 }
 })

 test("--probes writes starter probes file with example commented out", async () => {
 const { root, cleanup } = stage()
 try {
 const r = await runInit(root, ["--probes"])
 expect(r.exitCode).toBe(0)
 const target = join(root, ".claude-hooks", "probes.ts")
 expect(existsSync(target)).toBe(true)
 const body = readFileSync(target, "utf-8")
 expect(body).toContain("export const probes")
 expect(body).toContain("// \"tests-pass\":")
 } finally {
 cleanup()
 }
 })

 test("--feedback-dir creates feedback directory", async () => {
 const { root, cleanup } = stage()
 try {
 const r = await runInit(root, ["--feedback-dir"])
 expect(r.exitCode).toBe(0)
 expect(existsSync(join(root, ".claude-hooks", "feedback"))).toBe(true)
 } finally {
 cleanup()
 }
 })

 test("--install-skills with --print lists 15 skills under _bundled namespace", async () => {
 const { root, cleanup } = stage()
 try {
 const r = await runInit(root, ["--install-skills", "--print"])
 expect(r.exitCode).toBe(0)
 // 15 stubs ship in repo skills/
 const installLines = r.stdout.split("\n").filter((l) => /\[print\]\s+install/.test(l))
 const skipLines = r.stdout.split("\n").filter((l) => /\[print\]\s+skip/.test(l))
 // Some _bundled paths may already exist for users with prior runs in
 // the real $HOME. Total install+skip referencing skill files should
 // be at least 15.
 expect(installLines.length + skipLines.length).toBeGreaterThanOrEqual(15)
 } finally {
 cleanup()
 }
 })

 test("--install-skills (no --into-root) namespaces under ~/.claude/skills/_bundled/", async () => {
 const { root, cleanup } = stage()
 try {
 const r = await runInit(root, ["--install-skills", "--print"])
 // Every printed install path should contain `/_bundled/`
 const installs = r.stdout.split("\n").filter((l) => /\[print\]\s+install/.test(l))
 for (const line of installs) {
 expect(line).toContain("/_bundled/")
 }
 } finally {
 cleanup()
 }
 })

 test("--install-skills --into-root prints flat path (no _bundled)", async () => {
 const { root, cleanup } = stage()
 try {
 const r = await runInit(root, [
 "--install-skills",
 "--into-root",
 "--force",
 "--print",
 ])
 const printedLines = r.stdout
 .split("\n")
 .filter((l) => l.startsWith("[print]"))
 // No _bundled in any printed path
 for (const line of printedLines) {
 expect(line).not.toContain("/_bundled/")
 }
 // Path should contain ~/.claude/skills/<Name>/SKILL.md
 const home = homedir()
 const sample = printedLines.find((l) =>
 l.includes(join(home, ".claude", "skills")),
 )
 expect(sample).toBeDefined()
 } finally {
 cleanup()
 }
 })

 test("--install-skills --into-root WITHOUT --force refuses to overwrite", async () => {
 const { root, cleanup } = stage()
 try {
 const r = await runInit(root, ["--install-skills", "--into-root", "--print"])
 // For any skill that already exists in the real $HOME ~/.claude/skills/
 // (likely on users running an external host environment), expect a `skip` line, not an `overwrite` action.
 // The literal action keyword for an overwrite would be `[print] overwrite`;
 // the word "overwrite" CAN appear inside skip-message help text (it
 // tells you to pass --force).
 expect(r.stdout).not.toContain("[print] overwrite")
 } finally {
 cleanup()
 }
 })

 test("nothing-to-do (no flags, no-state-dir) prints help to stderr, exits 0", async () => {
 const { root, cleanup } = stage()
 try {
 const r = await runInit(root, ["--no-state-dir"])
 expect(r.exitCode).toBe(0)
 expect(r.stderr).toContain("nothing to do")
 } finally {
 cleanup()
 }
 })
})
