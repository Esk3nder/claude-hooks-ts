#!/usr/bin/env bun
/**
 * CI guard for B2 (silent-billing prevention).
 *
 * The ONLY sanctioned path for spawning the `claude` CLI is
 * `src/services/claude-subprocess.ts`, which always scrubs
 * ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDECODE before spawn so the
 * work routes through the user's subscription instead of getting silently
 * billed to an API key.
 *
 * This script greps `src/` for any other call site that might bypass the
 * chokepoint. Exits non-zero (and prints the offending file:line) on hit so
 * `bun run lint:claude-spawn` fails the build.
 *
 * Patterns flagged:
 *   Bun.spawn(["claude"
 *   child_process.spawn("claude"
 *   spawn("claude"
 *   execFile("claude"
 *   execSync("claude
 *   exec("claude
 *
 * If you legitimately need a new spawn path, add a method to the
 * ClaudeSubprocess service — do not bypass this guard.
 */

import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const SRC_ROOT = join(REPO_ROOT, "src")
const writeGuardStdout = (message: string): Promise<number> =>
  Bun.write(Bun.stdout, message)

const writeGuardStderr = (message: string): Promise<number> =>
  Bun.write(Bun.stderr, message)
/**
 * The chokepoint file is the only sanctioned `claude` spawn site in production.
 * The guard scans src/, test/, and scripts/ to catch test bypasses too — a
 * test that direct-spawns claude bypasses env scrubbing AND inflates billing.
 */
const SCAN_ROOTS: ReadonlyArray<string> = [
  SRC_ROOT,
  join(REPO_ROOT, "test"),
  join(REPO_ROOT, "scripts"),
]
const ALLOWED_FILES: ReadonlySet<string> = new Set([
  join(SRC_ROOT, "services", "claude-subprocess.ts"),
  // The guard script itself contains the patterns it's looking for.
  join(REPO_ROOT, "scripts", "check-claude-spawn.ts"),
  // The guard's tests stage offender files with the patterns inside string
  // literals — those literals would self-match if scanned.
  join(REPO_ROOT, "test", "scripts", "check-claude-spawn.test.ts"),
])

const PATTERNS: ReadonlyArray<{ readonly name: string; readonly re: RegExp }> = [
  { name: "Bun.spawn([\"claude\"", re: /Bun\.spawn\s*\(\s*\[\s*["']claude["']/ },
  { name: 'spawn("claude"', re: /\bspawn\s*\(\s*["']claude["']/ },
  { name: 'execFile("claude"', re: /\bexecFile\s*\(\s*["']claude["']/ },
  { name: 'execSync("claude', re: /\bexecSync\s*\(\s*["']\s*claude\b/ },
  { name: 'exec("claude', re: /\bexec\s*\(\s*["']\s*claude\b/ },
]

interface Hit {
  readonly file: string
  readonly line: number
  readonly text: string
  readonly pattern: string
}

const walk = async (dir: string): Promise<ReadonlyArray<string>> => {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    // Directory may not exist (e.g. test/ missing in a stripped install).
    return []
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      // Skip vendor / build dirs that may contain bundled TS we don't own.
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".bun") continue
      const nested = await walk(full)
      out.push(...nested)
    } else if (e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".tsx"))) {
      out.push(full)
    }
  }
  return out
}

const scan = async (): Promise<ReadonlyArray<Hit>> => {
  const files: string[] = []
  for (const root of SCAN_ROOTS) {
    files.push(...(await walk(root)))
  }
  const hits: Hit[] = []
  for (const file of files) {
    if (ALLOWED_FILES.has(file)) continue
    const raw = await readFile(file, "utf8")
    const lines = raw.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // Skip comment-only lines so we can document patterns in prose.
      const trimmed = line.trim()
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue
      for (const { name, re } of PATTERNS) {
        if (re.test(line)) {
          hits.push({
            file: relative(REPO_ROOT, file),
            line: i + 1,
            text: line.trim(),
            pattern: name,
          })
        }
      }
    }
  }
  return hits
}

const main = async (): Promise<void> => {
  const hits = await scan()
  if (hits.length === 0) {
    await writeGuardStdout("check-claude-spawn: OK (no direct claude spawns outside the chokepoint)\n")
    return
  }
  await writeGuardStderr(
    "check-claude-spawn: FAIL — direct `claude` spawns found outside src/services/claude-subprocess.ts:\n",
  )
  await writeGuardStderr("\n")
  for (const h of hits) {
    await writeGuardStderr(`  ${h.file}:${h.line}  [${h.pattern}]\n`)
    await writeGuardStderr(`    ${h.text}\n`)
  }
  await writeGuardStderr("\n")
  await writeGuardStderr("Route the call through ClaudeSubprocess.spawn() instead — env scrubbing\n")
  await writeGuardStderr("is mandatory to keep work on subscription billing (see B2 in plan).\n")
  process.exit(1)
}

if (import.meta.main) {
  await main()
}
