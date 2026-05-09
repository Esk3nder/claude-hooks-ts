#!/usr/bin/env bun
/**
 * claude-hooks-init — opt-in initializer for a project + per-user skill bundle.
 *
 * What it does (all idempotent, all opt-in via flags):
 *   - `--state-dir`        Create `<cwd>/.claude-hooks/state/` and parents.
 *                          Default ON.
 *   - `--regenerate`       Drop a starter `<cwd>/.claude-hooks/regenerate.yaml`
 *                          (commented examples). Default OFF — only adds when
 *                          the file does not exist already.
 *   - `--probes`           Drop a starter `<cwd>/.claude-hooks/probes.ts`.
 *                          Default OFF — only adds when missing.
 *   - `--feedback-dir`     Create `<cwd>/.claude-hooks/feedback/` empty dir.
 *                          Default OFF.
 *   - `--install-skills`   Install the 15 bundled SKILL.md stubs to
 *                          `~/.claude/skills/_bundled/<Name>/`. SAFE: never
 *                          overwrites a user's existing skill file at the
 *                          flat layout. Default OFF.
 *   - `--into-root`        With `--install-skills`, install into the flat
 *                          `~/.claude/skills/<Name>/` layout instead of
 *                          `_bundled/`. Will REFUSE to overwrite an existing
 *                          file unless `--force` is also given.
 *   - `--force`            Permits `--into-root` to overwrite collisions.
 *                          Use with care.
 *   - `--print`            Print what would be done without writing.
 *
 * Usage examples:
 *   claude-hooks-init                           # state dir only
 *   claude-hooks-init --regenerate --probes     # add starter config files
 *   claude-hooks-init --install-skills          # opt-in skill bundle (namespaced)
 *   claude-hooks-init --install-skills --into-root --force   # force flat install
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

interface CliArgs {
  readonly cwd: string
  readonly stateDir: boolean
  readonly regenerate: boolean
  readonly probes: boolean
  readonly feedbackDir: boolean
  readonly installSkills: boolean
  readonly intoRoot: boolean
  readonly force: boolean
  readonly print: boolean
}

const parseArgs = (argv: ReadonlyArray<string>): CliArgs => {
  const args = argv.slice(2)
  const flag = (name: string): boolean => args.includes(`--${name}`)
  const valueFor = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`)
    if (i === -1 || i + 1 >= args.length) return undefined
    return args[i + 1]
  }
  const cwdRaw = valueFor("cwd") ?? process.cwd()
  return {
    cwd: resolve(cwdRaw),
    stateDir: !flag("no-state-dir"),
    regenerate: flag("regenerate"),
    probes: flag("probes"),
    feedbackDir: flag("feedback-dir"),
    installSkills: flag("install-skills"),
    intoRoot: flag("into-root"),
    force: flag("force"),
    print: flag("print"),
  }
}

const REGENERATE_STARTER = `# claude-hooks regenerate rules.
# When source files in this list are modified during a session, the matching
# command runs at Stop (best-effort, 10s timeout, never blocks).
#
# Wildcards: \`*\` only (no \`**\`, no character classes). Command can be a
# shell string or a JSON array \`["bun", "run", "scripts/x.ts"]\`.

rules: []
#  - source: docs/architecture.md
#    derived: docs/SUMMARY.md
#    command: bun run scripts/gen-summary.ts
`

const PROBES_STARTER = `// claude-hooks ISC probes — auto-verifies ISCs after tool calls.
//
// The Test Strategy section in your ISA names a probe per ISC like:
//
//     | isc   | type | check | threshold | tool        |
//     | ISC-1 | bun  | smoke | n/a       | tests-pass  |
//
// When PostToolUse fires (any tool, not just edits), each probe whose ISC
// is currently \`[ ]\` runs. A return value of \`true\` flips the checkbox to
// \`[x]\`, which then triggers the checkpoint git commit (if your
// \`.claude-hooks/checkpoint-repos.txt\` opt-in is set up).
//
// Probes run in the dispatcher process with full Node privileges — no
// sandbox. Each probe is wrapped in a 1s timeout and a catch-all that
// treats failure as a non-passing probe.
//
// CriterionEntry shape (mirrored from src/algorithm/isa/criteria.ts so this
// file is self-contained — no package-internal imports needed).

interface CriterionEntry {
  readonly id: string
  readonly description: string
  readonly type: "criterion" | "anti-criterion"
  readonly status: "pending" | "completed"
  readonly category?: string
}

export const probes: Record<string, (criterion: CriterionEntry) => boolean | Promise<boolean>> = {
  // "tests-pass": async () => {
  //   // Example: shell out to bun test, check exit code.
  //   const { execFileSync } = await import("node:child_process")
  //   try {
  //     execFileSync("bun", ["test", "--bail"], { stdio: "ignore", timeout: 800 })
  //     return true
  //   } catch {
  //     return false
  //   }
  // },
}
`

interface Action {
  readonly description: string
  readonly run: () => void
}

const buildActions = (args: CliArgs): ReadonlyArray<Action> => {
  const out: Action[] = []
  if (args.stateDir) {
    const statePath = join(args.cwd, ".claude-hooks", "state")
    out.push({
      description: `mkdir ${statePath}`,
      run: () => mkdirSync(statePath, { recursive: true }),
    })
  }
  if (args.feedbackDir) {
    const fbPath = join(args.cwd, ".claude-hooks", "feedback")
    out.push({
      description: `mkdir ${fbPath}`,
      run: () => mkdirSync(fbPath, { recursive: true }),
    })
  }
  if (args.regenerate) {
    const target = join(args.cwd, ".claude-hooks", "regenerate.yaml")
    if (existsSync(target)) {
      out.push({
        description: `skip ${target} (exists)`,
        run: () => undefined,
      })
    } else {
      out.push({
        description: `write ${target}`,
        run: () => {
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, REGENERATE_STARTER, "utf-8")
        },
      })
    }
  }
  if (args.probes) {
    const target = join(args.cwd, ".claude-hooks", "probes.ts")
    if (existsSync(target)) {
      out.push({
        description: `skip ${target} (exists)`,
        run: () => undefined,
      })
    } else {
      out.push({
        description: `write ${target}`,
        run: () => {
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, PROBES_STARTER, "utf-8")
        },
      })
    }
  }
  if (args.installSkills) {
    out.push(...buildSkillActions(args))
  }
  return out
}

const SKILLS_PACKAGE_DIR = new URL("../skills", import.meta.url).pathname.replace(/\/$/, "")

const buildSkillActions = (args: CliArgs): ReadonlyArray<Action> => {
  const out: Action[] = []
  let entries: ReadonlyArray<string> = []
  try {
    entries = readdirSync(SKILLS_PACKAGE_DIR)
  } catch {
    out.push({
      description: `[install-skills] skills dir not found at ${SKILLS_PACKAGE_DIR}`,
      run: () => undefined,
    })
    return out
  }
  const home = homedir()
  const dest = args.intoRoot
    ? join(home, ".claude", "skills")
    : join(home, ".claude", "skills", "_bundled")
  for (const name of entries) {
    const src = join(SKILLS_PACKAGE_DIR, name, "SKILL.md")
    if (!existsSync(src)) continue
    const targetDir = join(dest, name)
    const targetFile = join(targetDir, "SKILL.md")
    if (existsSync(targetFile)) {
      if (args.intoRoot && args.force) {
        out.push({
          description: `overwrite ${targetFile} (--force)`,
          run: () => {
            mkdirSync(targetDir, { recursive: true })
            copyFileSync(src, targetFile)
          },
        })
      } else {
        out.push({
          description: `skip ${targetFile} (exists${args.intoRoot ? " — pass --force to overwrite" : ""})`,
          run: () => undefined,
        })
      }
    } else {
      out.push({
        description: `install ${targetFile}`,
        run: () => {
          mkdirSync(targetDir, { recursive: true })
          copyFileSync(src, targetFile)
        },
      })
    }
  }
  return out
}

export const main = (argv: ReadonlyArray<string>): number => {
  const args = parseArgs(argv)
  const actions = buildActions(args)
  if (actions.length === 0) {
    process.stderr.write(
      "claude-hooks-init: nothing to do. Try --regenerate / --probes / --install-skills / --feedback-dir.\n",
    )
    return 0
  }
  let failures = 0
  for (const a of actions) {
    if (args.print) {
      process.stdout.write(`[print] ${a.description}\n`)
      continue
    }
    try {
      a.run()
      process.stdout.write(`[ok]    ${a.description}\n`)
    } catch (err) {
      failures += 1
      process.stderr.write(`[fail]  ${a.description}: ${String(err)}\n`)
    }
  }
  return failures > 0 ? 1 : 0
}

if (import.meta.main) {
  process.exit(main(process.argv))
}
