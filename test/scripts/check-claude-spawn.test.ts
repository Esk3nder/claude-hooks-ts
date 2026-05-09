import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = new URL("../../scripts/check-claude-spawn.ts", import.meta.url).pathname

interface Run {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const runGuard = async (cwd: string): Promise<Run> => {
  // CRITICAL: invoke the COPY of the script that lives inside `cwd` so that
  // `import.meta.url` inside the script resolves to the staged repo root.
  // Running the real /scripts/check-claude-spawn.ts would scan the real src/.
  const stagedScript = join(cwd, "scripts", "check-claude-spawn.ts")
  const proc = Bun.spawn(["bun", "run", stagedScript], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ])
  const exitCode = await proc.exited
  return { stdout, stderr, exitCode: typeof exitCode === "number" ? exitCode : -1 }
}

/**
 * Stage a fake repo whose layout the guard expects: <root>/scripts/check-claude-spawn.ts
 * + <root>/src/services/claude-subprocess.ts (the allowed file) + a sibling
 * file under src/ that we can dirty per-test. The guard resolves both
 * REPO_ROOT and ALLOWED_FILE relative to the script's own URL, so we copy the
 * real script into the staged tree.
 */
const stageRepo = (): { root: string; offender: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "chts-guard-"))
  mkdirSync(join(root, "scripts"), { recursive: true })
  mkdirSync(join(root, "src", "services"), { recursive: true })
  mkdirSync(join(root, "src", "events"), { recursive: true })
  // Copy the real script verbatim so REPO_ROOT/ALLOWED_FILE resolution stays correct.
  const realScript = Bun.file(SCRIPT)
  // synchronous read via Bun
  const scriptText = require("node:fs").readFileSync(SCRIPT, "utf8")
  writeFileSync(join(root, "scripts", "check-claude-spawn.ts"), scriptText)
  // Allowed file — chokepoint placeholder. Even if it contains the patterns,
  // the guard MUST exempt it.
  writeFileSync(
    join(root, "src", "services", "claude-subprocess.ts"),
    `// chokepoint\nBun.spawn(["claude", "--print"])\n`,
  )
  void realScript
  const offender = join(root, "src", "events", "naughty.ts")
  return {
    root,
    offender,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

describe("scripts/check-claude-spawn.ts (B2 CI guard)", () => {
  test("OK on a tree where only the chokepoint spawns claude", async () => {
    const { root, cleanup } = stageRepo()
    try {
      // No offender written — the only claude spawn is in the allowed file.
      writeFileSync(
        join(root, "src", "events", "innocent.ts"),
        `export const x = "claude"\n`, // bare string literal, no spawn — must NOT trip
      )
      const r = await runGuard(root)
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain("OK")
    } finally {
      cleanup()
    }
  }, 15_000)

  test("FAILs when Bun.spawn([\"claude\" appears outside the chokepoint", async () => {
    const { root, offender, cleanup } = stageRepo()
    try {
      writeFileSync(offender, `Bun.spawn(["claude", "--print"])\n`)
      const r = await runGuard(root)
      expect(r.exitCode).toBe(1)
      expect(r.stderr).toContain("FAIL")
      expect(r.stderr).toContain("naughty.ts")
    } finally {
      cleanup()
    }
  }, 15_000)

  test("FAILs on child_process spawn(\"claude\"", async () => {
    const { root, offender, cleanup } = stageRepo()
    try {
      writeFileSync(
        offender,
        `import { spawn } from "child_process"\nspawn("claude", ["--print"])\n`,
      )
      const r = await runGuard(root)
      expect(r.exitCode).toBe(1)
      expect(r.stderr).toContain("naughty.ts")
    } finally {
      cleanup()
    }
  }, 15_000)

  test("FAILs on execFile(\"claude\"", async () => {
    const { root, offender, cleanup } = stageRepo()
    try {
      writeFileSync(offender, `execFile("claude", ["--print"])\n`)
      const r = await runGuard(root)
      expect(r.exitCode).toBe(1)
    } finally {
      cleanup()
    }
  }, 15_000)

  test("does NOT trip on the literal string \"claude\" alone", async () => {
    const { root, cleanup } = stageRepo()
    try {
      writeFileSync(
        join(root, "src", "events", "bystander.ts"),
        `export const name = "claude"\nexport const note = "we use claude here"\n`,
      )
      const r = await runGuard(root)
      expect(r.exitCode).toBe(0)
    } finally {
      cleanup()
    }
  }, 15_000)

  test("does NOT trip on commented-out spawn lines", async () => {
    const { root, cleanup } = stageRepo()
    try {
      writeFileSync(
        join(root, "src", "events", "commented.ts"),
        `// Bun.spawn(["claude", "--print"]) — example only\n* execFile("claude", []) in a docstring\n`,
      )
      const r = await runGuard(root)
      expect(r.exitCode).toBe(0)
    } finally {
      cleanup()
    }
  }, 15_000)
})
