/**
 * v2 cutover installer (MIGRATION-PLAN M3). Replaces the old claude-hooks-ts hook
 * stack with the v2 adapter for the events v2 owns, retiring the old classifier/
 * ISA/worker planes. Timestamped backup of settings.json is the rollback.
 *
 *   bun scripts/install-v2.ts            # apply the cutover (default)
 *   bun scripts/install-v2.ts --dry-run  # show what would change
 *   bun scripts/install-v2.ts --restore <backup>  # roll back
 *
 * v2 owns: SessionStart, PreToolUse, SubagentStart, SubagentStop, Stop.
 * Other events are removed (the old dispatcher no longer runs). Verdict injection
 * (PostToolUse) is file-only in this cutover; wire it when the host-id probe lands.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const V2_BIN = join(PKG_ROOT, "bin", "claude-hooks-v2")
const V2_EVENTS = ["SessionStart", "PreToolUse", "SubagentStart", "SubagentStop", "Stop"] as const

type Settings = Record<string, unknown> & { hooks?: Record<string, unknown> }

function v2Entry() {
  return [{ hooks: [{ type: "command", command: `'${V2_BIN}'`, timeout: 30 }] }]
}

function buildHooks(): Record<string, unknown> {
  const hooks: Record<string, unknown> = {}
  for (const e of V2_EVENTS) hooks[e] = v2Entry()
  return hooks
}

function main(): number {
  const args = process.argv.slice(2)
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

  let settings: Settings = {}
  if (existsSync(target)) {
    try { settings = JSON.parse(readFileSync(target, "utf8")) as Settings }
    catch (e) { console.error(`target unparseable, refusing: ${String(e).slice(0, 120)}`); return 1 }
  }

  const oldEventCount = Object.keys(settings.hooks ?? {}).length
  const next: Settings = { ...settings, hooks: buildHooks() }

  if (dryRun) {
    console.log(`dry-run: would replace ${oldEventCount} wired hook events with v2 on ${V2_EVENTS.length} events:`)
    console.log(`  ${V2_EVENTS.join(", ")} -> '${V2_BIN}'`)
    console.log(`  (old planes on all other events removed; restore from backup to revert)`)
    return 0
  }

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

  console.log(`CUTOVER APPLIED`)
  console.log(`  target:  ${target}`)
  console.log(`  backup:  ${backupNote}`)
  console.log(`  v2 owns: ${V2_EVENTS.join(", ")}`)
  console.log(`  retired: ${oldEventCount} old hook events (classifier/ISA/worker planes)`)
  console.log(`  rollback: bun ${join(PKG_ROOT, "scripts", "install-v2.ts")} --restore "${backupNote}"`)
  return 0
}

process.exit(main())
