/**
 * Algorithm-aware doctor checks (Phase 5):
 * - classifier subprocess available
 * - classifier billing path
 * - thinking-capability skill stubs installed
 * - active ISA
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
  symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const SCRIPT = new URL("../../scripts/doctor.ts", import.meta.url).pathname

interface DoctorRun {
  readonly stdout: string
  readonly exitCode: number
  readonly results: ReadonlyArray<{
    name: string
    status: string
    detail?: string
  }>
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
  let results: ReadonlyArray<{
    name: string
    status: string
    detail?: string
  }> = []
  try {
    results = JSON.parse(stdout) as Array<{
      name: string
      status: string
      detail?: string
    }>
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

  test("bypass set AND `claude` not on PATH → still INFO bypass message (CI scenario)", async () => {
    // Regression: previous order checked PATH first, so in CI where
    // `claude` isn't installed the function returned the PATH-missing
    // INFO and never reached the bypass branch — the test for the bypass
    // message then failed in CI but passed locally. The fix prioritizes
    // bypass because it's actionable regardless of install state.
    //
    // Simulate "claude not on PATH" by pointing PATH at a tmpdir that
    // contains only a symlink to bun (so the doctor subprocess itself
    // still launches), with no claude binary or symlink anywhere on it.
    const { root, cleanup } = stage()
    const fakePathDir = mkdtempSync(join(tmpdir(), "chts-fakepath-"))
    try {
      const realBun = Bun.which("bun")
      if (realBun !== null) {
        symlinkSync(realBun, join(fakePathDir, "bun"))
      }
      const r = await runDoctor(root, {
        CLAUDE_HOOKS_DISABLE_CLASSIFIER: "1",
        PATH: fakePathDir,
      })
      const check = find(r.results, "classifier subprocess available")
      expect(check?.status).toBe("INFO")
      expect(check?.detail ?? "").toContain("CLAUDE_HOOKS_DISABLE_CLASSIFIER")
    } finally {
      rmSync(fakePathDir, { recursive: true, force: true })
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

describe("doctor — ISA storage location (legacy migration WARN)", () => {
  test("no .claude-hooks/state/work dir → check is silent (no entry)", async () => {
    const { root, cleanup } = stage()
    try {
      const r = await runDoctor(root)
      const check = find(r.results, "ISA storage location")
      expect(check).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test("legacy state/work has ISAs but canonical work also has ISAs → check is silent", async () => {
    const { root, cleanup } = stage()
    try {
      const legacy = join(root, ".claude-hooks", "state", "work", "old-slug")
      mkdirSync(legacy, { recursive: true })
      writeFileSync(join(legacy, "ISA.md"), `## Goal\nx\n`, "utf-8")
      const canonical = join(root, ".claude-hooks", "work", "new-slug")
      mkdirSync(canonical, { recursive: true })
      writeFileSync(join(canonical, "ISA.md"), `## Goal\ny\n`, "utf-8")
      const r = await runDoctor(root)
      const check = find(r.results, "ISA storage location")
      // Once the canonical layout is in use, treat the legacy residue
      // as historical — no migration WARN.
      expect(check).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test("ONLY legacy state/work has ISAs → WARN with migration command", async () => {
    const { root, cleanup } = stage()
    try {
      const legacy1 = join(root, ".claude-hooks", "state", "work", "task-a")
      const legacy2 = join(root, ".claude-hooks", "state", "work", "task-b")
      mkdirSync(legacy1, { recursive: true })
      mkdirSync(legacy2, { recursive: true })
      writeFileSync(join(legacy1, "ISA.md"), `## Goal\na\n`, "utf-8")
      writeFileSync(join(legacy2, "ISA.md"), `## Goal\nb\n`, "utf-8")
      const r = await runDoctor(root)
      const check = find(r.results, "ISA storage location")
      expect(check?.status).toBe("WARN")
      expect(check?.detail ?? "").toContain("legacy gitignored path")
      expect(check?.detail ?? "").toContain("task-a")
      expect(check?.detail ?? "").toContain("task-b")
      expect(check?.detail ?? "").toContain("mv .claude-hooks/state/work/")
    } finally {
      cleanup()
    }
  })

  test("WARN does NOT cause non-zero exit (migration is advisory)", async () => {
    const { root, cleanup } = stage()
    try {
      const legacy = join(root, ".claude-hooks", "state", "work", "x")
      mkdirSync(legacy, { recursive: true })
      writeFileSync(join(legacy, "ISA.md"), `## Goal\nz\n`, "utf-8")
      const r = await runDoctor(root)
      // FAIL is the only status that bumps exitCode; WARN is just a signal.
      expect(r.exitCode).toBe(0)
    } finally {
      cleanup()
    }
  })
})

describe("doctor — thinking-capability skill stubs", () => {
  test("status reports an integer count when skills exist", async () => {
    const { root, cleanup } = stage()
    try {
      // The host running tests may have installed (real skills) — we only
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
