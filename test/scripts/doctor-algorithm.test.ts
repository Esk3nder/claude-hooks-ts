/**
 * Algorithm-aware doctor checks (Phase 5):
 *   - classifier subprocess available
 *   - classifier billing path
 *   - thinking-capability skill stubs installed
 *   - active ISA
 *
 * The script reads from real $HOME for skill counts and uses --cwd for the
 * ISA / state checks. We stage tmpdirs for cwd-side assertions and inspect
 * env-driven branches.
 */
import { describe, expect, test } from "bun:test"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = new URL("../../scripts/doctor.ts", import.meta.url).pathname

interface DoctorRun {
  readonly stdout: string
  readonly exitCode: number
  readonly results: ReadonlyArray<{ name: string; status: string; detail?: string }>
}

const runDoctor = async (
  cwd: string,
  env: Record<string, string | undefined> = {},
): Promise<DoctorRun> => {
  const merged: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") merged[k] = v
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k]
    else merged[k] = v
  }
  const proc = Bun.spawn(["bun", "run", SCRIPT, "--cwd", cwd, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    env: merged,
  })
  const stdout = await new Response(proc.stdout as ReadableStream).text()
  const exitCode = await proc.exited
  let results: ReadonlyArray<{ name: string; status: string; detail?: string }> = []
  try {
    results = JSON.parse(stdout) as Array<{ name: string; status: string; detail?: string }>
  } catch {
    // ignore
  }
  return {
    stdout,
    exitCode: typeof exitCode === "number" ? exitCode : -1,
    results,
  }
}

const stage = (): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "chts-doctor-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const find = (
  results: ReadonlyArray<{ name: string; status: string; detail?: string }>,
  name: string,
) => results.find((r) => r.name === name)

describe("doctor — classifier subprocess available", () => {
  test("CLAUDE_HOOKS_DISABLE_CLASSIFIER=1 → INFO bypass message", async () => {
    const { root, cleanup } = stage()
    try {
      const r = await runDoctor(root, { CLAUDE_HOOKS_DISABLE_CLASSIFIER: "1" })
      const check = find(r.results, "classifier subprocess available")
      expect(check?.status).toBe("INFO")
      expect(check?.detail ?? "").toContain("CLAUDE_HOOKS_DISABLE_CLASSIFIER")
    } finally {
      cleanup()
    }
  })
})

describe("doctor — classifier billing path", () => {
  test("ANTHROPIC_API_KEY set → INFO with scrub note", async () => {
    const { root, cleanup } = stage()
    try {
      const r = await runDoctor(root, {
        ANTHROPIC_API_KEY: "sk-ant-fake",
      })
      const check = find(r.results, "classifier billing path")
      expect(check?.status).toBe("INFO")
      expect(check?.detail ?? "").toContain("ANTHROPIC_API_KEY")
      expect(check?.detail ?? "").toContain("scrub")
    } finally {
      cleanup()
    }
  })

  test("only CLAUDE_CODE_OAUTH_TOKEN set → PASS subscription billing", async () => {
    const { root, cleanup } = stage()
    try {
      const r = await runDoctor(root, {
        CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth",
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
      })
      const check = find(r.results, "classifier billing path")
      expect(check?.status).toBe("PASS")
      expect(check?.detail ?? "").toContain("subscription")
    } finally {
      cleanup()
    }
  })
})

describe("doctor — active ISA", () => {
  test("no ISA at cwd → INFO", async () => {
    const { root, cleanup } = stage()
    try {
      const r = await runDoctor(root)
      const check = find(r.results, "active ISA")
      expect(check?.status).toBe("INFO")
      expect(check?.detail ?? "").toContain("no ISA")
    } finally {
      cleanup()
    }
  })

  test("project ISA at cwd → PASS with phase + progress", async () => {
    const { root, cleanup } = stage()
    try {
      writeFileSync(
        join(root, "ISA.md"),
        `---\ntask: x\nphase: build\nprogress: 1/3\n---\n## Goal\nx\n`,
        "utf-8",
      )
      const r = await runDoctor(root)
      const check = find(r.results, "active ISA")
      expect(check?.status).toBe("PASS")
      expect(check?.detail ?? "").toContain("phase=build")
      expect(check?.detail ?? "").toContain("progress=1/3")
    } finally {
      cleanup()
    }
  })

  test("task ISA found when no project ISA", async () => {
    const { root, cleanup } = stage()
    try {
      const dir = join(root, ".claude-hooks", "state", "work", "20260509_t")
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, "ISA.md"),
        `---\ntask: y\nphase: observe\nprogress: 0/0\n---\n`,
        "utf-8",
      )
      const r = await runDoctor(root)
      const check = find(r.results, "active ISA")
      expect(check?.status).toBe("PASS")
      expect(check?.detail ?? "").toContain("phase=observe")
    } finally {
      cleanup()
    }
  })
})

describe("doctor — thinking-capability skill stubs", () => {
  test("status reports an integer count when skills exist", async () => {
    const { root, cleanup } = stage()
    try {
      // The host running tests may have PAI installed (real skills) — we only
      // assert that the check executes and produces either PASS or INFO.
      const r = await runDoctor(root)
      const check = find(r.results, "thinking-capability skill stubs installed")
      expect(check).toBeDefined()
      expect(["PASS", "INFO"]).toContain(check?.status ?? "")
    } finally {
      cleanup()
    }
  })
})
