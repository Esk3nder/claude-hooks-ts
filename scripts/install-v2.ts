/**
 * v2 cutover installer (MIGRATION-PLAN M3).
 *
 *   bun scripts/install-v2.ts --faithful   # RECOMMENDED: v2 seam+gates, keep the old
 *                                           # binary's KEEP-list value, ceremony dead
 *   bun scripts/install-v2.ts               # blunt cutover (v2 only on 5 events)
 *   bun scripts/install-v2.ts --dry-run [--faithful]
 *   bun scripts/install-v2.ts --restore <backup>
 *
 * Faithful re-cut: the classifier/ISA ceremony is killed by NOT wiring
 * UserPromptSubmit (the only writer of engagement state) and by the
 * CLAUDE_HOOKS_DISABLE_* env flags. The old binary keeps running the audit's
 * KEEP-list (compaction snapshots, permission autopilot, verify-map Stop gate,
 * content-scan, context guards). v2 owns the worker seam and its gates. Events
 * shared by both (PreToolUse, Stop, SessionStart) run both hooks — most-
 * restrictive-wins for gates, union for context injection.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const V2_BIN = join(PKG_ROOT, "bin", "claude-hooks-v2")
const OLD_BIN = join(PKG_ROOT, "bin", "claude-hook")
const V2_EVENTS = ["SessionStart", "PreToolUse", "SubagentStart", "SubagentStop", "Stop"] as const

// All 29 Claude Code hook events — v2 is wired on EVERY one (aware; no-ops where it has no logic).
const ALL_EVENTS = [
  "ConfigChange", "CwdChanged", "Elicitation", "ElicitationResult", "FileChanged",
  "InstructionsLoaded", "Notification", "PermissionDenied", "PermissionRequest",
  "PostCompact", "PostToolBatch", "PostToolUse", "PostToolUseFailure", "PreCompact",
  "PreToolUse", "SessionEnd", "SessionStart", "Setup", "Stop", "StopFailure",
  "SubagentStart", "SubagentStop", "TaskCompleted", "TaskCreated", "TeammateIdle",
  "UserPromptExpansion", "UserPromptSubmit", "WorktreeCreate", "WorktreeRemove",
] as const
// v2 owns these SOLO (full safety + the seam) — old binary not wired here.
const V2_SOLE = new Set(["PreToolUse", "SubagentStart", "SubagentStop"])
// Ceremony — old binary NOT wired (would resurrect the classifier/task gates); v2 stays aware.
const NO_OLD = new Set(["UserPromptSubmit", "TaskCreated", "TaskCompleted", "PostToolBatch"])
const CEREMONY_FLAGS = { CLAUDE_HOOKS_DISABLE_CLASSIFIER: "1", CLAUDE_HOOKS_DISABLE_ISA_PRETOOL_GATE: "1" }

type HookObj = { type: string; command: string; timeout: number }
type Entry = { matcher?: string; hooks: HookObj[] }
type Settings = Record<string, unknown> & { hooks?: Record<string, Entry[]>; env?: Record<string, string> }

const v2Hook = (): HookObj => ({ type: "command", command: `'${V2_BIN}'`, timeout: 30 })
const oldHook = (event: string): HookObj => ({ type: "command", command: `'${OLD_BIN}' ${event}`, timeout: 30 })

function buildFaithful(): { hooks: Record<string, Entry[]>; env: Record<string, string> } {
  const hooks: Record<string, Entry[]> = {}
  for (const e of ALL_EVENTS) {
    const entries: Entry[] = []
    // old binary first (its KEEP-list value), where it isn't ceremony and v2 doesn't own it solo
    if (!V2_SOLE.has(e) && !NO_OLD.has(e)) entries.push({ hooks: [oldHook(e)] })
    // v2 on EVERY event — aware of all 29, active on the ones it handles
    entries.push({ hooks: [v2Hook()] })
    hooks[e] = entries
  }
  return { hooks, env: CEREMONY_FLAGS }
}

function buildBlunt(): { hooks: Record<string, Entry[]>; env: Record<string, string> } {
  const hooks: Record<string, Entry[]> = {}
  for (const e of V2_EVENTS) hooks[e] = [{ hooks: [v2Hook()] }]
  return { hooks, env: {} }
}

function main(): number {
  const args = process.argv.slice(2)
  const faithful = args.includes("--faithful")
  const dryRun = args.includes("--dry-run")
  const restoreIdx = args.indexOf("--restore")
  const targetIdx = args.indexOf("--target")
  const target = targetIdx >= 0 ? args[targetIdx + 1]! : join(homedir(), ".claude", "settings.json")

  if (restoreIdx >= 0) {
    const backup = args[restoreIdx + 1]
    if (!backup || !existsSync(backup)) { console.error(`restore: backup not found: ${backup}`); return 1 }
    copyFileSync(backup, target)
    console.log(`restored ${target} from ${backup}`)
    return 0
  }

  if (!existsSync(V2_BIN)) { console.error(`v2 binary missing: ${V2_BIN}`); return 1 }
  if (faithful && !existsSync(OLD_BIN)) { console.error(`old binary missing (needed for --faithful): ${OLD_BIN}`); return 1 }

  let settings: Settings = {}
  if (existsSync(target)) {
    try { settings = JSON.parse(readFileSync(target, "utf8")) as Settings }
    catch (e) { console.error(`target unparseable, refusing: ${String(e).slice(0, 120)}`); return 1 }
  }

  const built = faithful ? buildFaithful() : buildBlunt()
  const next: Settings = { ...settings, hooks: built.hooks, env: { ...(settings.env ?? {}), ...built.env } }

  const summary = () => {
    const evs = Object.keys(built.hooks)
    if (faithful) {
      const both = evs.filter((e) => built.hooks[e]!.length === 2)
      const v2only = evs.filter((e) => !V2_SOLE.has(e) && NO_OLD.has(e))
      console.log(`  mode:    FAITHFUL — v2 aware of ALL ${evs.length} events`)
      console.log(`  v2 sole: ${[...V2_SOLE].join(", ")} (full safety + the seam)`)
      console.log(`  v2-only (aware, no old / ceremony dead): ${v2only.join(", ")}`)
      console.log(`  old+v2 (KEEP-list value + v2 aware): ${both.length} events incl. PostToolUse, Pre/PostCompact, Permission*, Stop, WorktreeCreate`)
      console.log(`  env flags: ${Object.keys(CEREMONY_FLAGS).join(", ")}`)
    } else {
      console.log(`  mode:    blunt — v2 on ${evs.length} events`)
    }
  }

  if (dryRun) { console.log("dry-run:"); summary(); return 0 }

  mkdirSync(dirname(target), { recursive: true })
  let backupNote = "(no prior settings)"
  if (existsSync(target)) {
    const backup = `${target}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`
    copyFileSync(target, backup)
    backupNote = backup
  }
  const tmp = `${target}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n")
  renameSync(tmp, target)

  console.log(`APPLIED`)
  console.log(`  target:  ${target}`)
  console.log(`  backup:  ${backupNote}`)
  summary()
  console.log(`  rollback: bun ${join(PKG_ROOT, "scripts", "install-v2.ts")} --restore "${backupNote}"`)
  return 0
}

process.exit(main())
