#!/usr/bin/env bun
/**
 * Install/uninstall claude-hooks-ts hook entries into a Claude Code
 * settings.json file. Non-destructive merge: existing unrelated hooks are
 * preserved; ours are keyed by command-path prefix and replaced idempotently.
 *
 * Usage:
 *   bun run scripts/install.ts               # dry-run by default
 *   bun run scripts/install.ts --apply       # write changes atomically
 *   bun run scripts/install.ts --uninstall   # remove our entries
 *   bun run scripts/install.ts --target /path/to/settings.json
 *
 * Exit codes: 0 success, 1 error/conflict.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

const DISPATCHER_MARKERS = ["claude-hooks-ts/bin/claude-hook", "claude-hook"]
const DEFAULT_TARGET = path.join(os.homedir(), ".claude", "settings.json")

const RESET = "\x1b[0m"
const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const CYAN = "\x1b[36m"

interface HookCommandEntry {
  type: "command"
  command: string
  timeout?: number
}

interface HookMatcher {
  matcher?: string
  hooks: HookCommandEntry[]
}

type HookEvent = string

interface SettingsShape {
  hooks?: Record<HookEvent, HookMatcher[]>
  [k: string]: unknown
}

const HOOK_EVENTS: ReadonlyArray<HookEvent> = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolBatch",
  "PostToolUseFailure",
  "Stop",
  "PreCompact",
  "SessionEnd",
  "PermissionRequest",
  "ConfigChange",
  "FileChanged",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
]

const buildEntries = (
  installRoot: string,
): Record<HookEvent, HookMatcher[]> => {
  const dispatcher = path.join(installRoot, "bin", "claude-hook")
  const out: Record<HookEvent, HookMatcher[]> = {}
  for (const ev of HOOK_EVENTS) {
    out[ev] = [
      {
        hooks: [
          {
            type: "command",
            command: `${dispatcher} ${ev}`,
            timeout: 30,
          },
        ],
      },
    ]
  }
  return out
}

const readJsonOr = <T>(file: string, fallback: T): T => {
  try {
    const raw = fs.readFileSync(file, "utf8")
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const isOurEntry = (entry: HookCommandEntry): boolean =>
  DISPATCHER_MARKERS.some((m) => entry.command.includes(m))

const stripOurMatchers = (matchers: HookMatcher[]): HookMatcher[] => {
  const filtered: HookMatcher[] = []
  for (const m of matchers) {
    const keptHooks = (m.hooks ?? []).filter((h) => !isOurEntry(h))
    if (keptHooks.length > 0) {
      filtered.push({ ...m, hooks: keptHooks })
    }
  }
  return filtered
}

const mergeHooks = (
  existing: SettingsShape,
  ours: Record<HookEvent, HookMatcher[]>,
  mode: "install" | "uninstall",
): SettingsShape => {
  const next: SettingsShape = { ...existing }
  const hooks: Record<HookEvent, HookMatcher[]> = { ...(existing.hooks ?? {}) }
  for (const ev of HOOK_EVENTS) {
    const stripped = stripOurMatchers(hooks[ev] ?? [])
    if (mode === "install") {
      const ourMatchers = ours[ev] ?? []
      hooks[ev] = [...stripped, ...ourMatchers]
    } else {
      if (stripped.length === 0) {
        delete hooks[ev]
      } else {
        hooks[ev] = stripped
      }
    }
  }
  next.hooks = hooks
  return next
}

const colorDiff = (before: string, after: string): string => {
  const bLines = before.split("\n")
  const aLines = after.split("\n")
  const max = Math.max(bLines.length, aLines.length)
  const out: string[] = []
  for (let i = 0; i < max; i += 1) {
    const b = bLines[i]
    const a = aLines[i]
    if (b === a) {
      if (a !== undefined) out.push(`  ${a}`)
    } else {
      if (b !== undefined) out.push(`${RED}- ${b}${RESET}`)
      if (a !== undefined) out.push(`${GREEN}+ ${a}${RESET}`)
    }
  }
  return out.join("\n")
}

const atomicWrite = (file: string, contents: string): void => {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  if (fs.existsSync(file)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-")
    const bak = `${file}.bak.${ts}`
    fs.copyFileSync(file, bak)
    process.stdout.write(`${CYAN}backup:${RESET} ${bak}\n`)
  }
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, contents, "utf8")
  fs.renameSync(tmp, file)
}

interface CliArgs {
  apply: boolean
  uninstall: boolean
  target: string
  installRoot: string
}

const parseArgs = (argv: ReadonlyArray<string>): CliArgs => {
  let apply = false
  let uninstall = false
  let target = DEFAULT_TARGET
  let installRoot = path.resolve(__dirname, "..")
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === "--apply") apply = true
    else if (a === "--dry-run") apply = false
    else if (a === "--uninstall") uninstall = true
    else if (a === "--target" && i + 1 < argv.length) {
      target = argv[i + 1]!
      i += 1
    } else if (a === "--install-root" && i + 1 < argv.length) {
      installRoot = argv[i + 1]!
      i += 1
    }
  }
  return { apply, uninstall, target, installRoot }
}

export const runInstall = (
  argv: ReadonlyArray<string>,
  out: NodeJS.WritableStream = process.stdout,
): number => {
  const args = parseArgs(argv)
  const existing = readJsonOr<SettingsShape>(args.target, {})
  const ours = buildEntries(args.installRoot)
  const merged = mergeHooks(
    existing,
    ours,
    args.uninstall ? "uninstall" : "install",
  )
  const beforeStr = JSON.stringify(existing, null, 2)
  const afterStr = JSON.stringify(merged, null, 2)
  if (beforeStr === afterStr) {
    out.write(`${YELLOW}no changes${RESET} (target already in desired state)\n`)
    return 0
  }
  out.write(
    `${CYAN}target:${RESET} ${args.target}  ${CYAN}mode:${RESET} ${args.uninstall ? "uninstall" : "install"}  ${CYAN}apply:${RESET} ${args.apply}\n`,
  )
  out.write(colorDiff(beforeStr, afterStr) + "\n")
  if (args.apply) {
    try {
      atomicWrite(args.target, afterStr)
      out.write(`${GREEN}wrote:${RESET} ${args.target}\n`)
    } catch (e) {
      out.write(`${RED}error:${RESET} ${String(e)}\n`)
      return 1
    }
  } else {
    out.write(
      `${YELLOW}dry-run:${RESET} re-run with --apply to write changes\n`,
    )
  }
  return 0
}

if (import.meta.main) {
  const code = runInstall(process.argv.slice(2))
  process.exit(code)
}
