#!/usr/bin/env bun
/**
 * Manually record an approval/denial in the Approvals ledger.
 *
 * Usage:
 *   bun run scripts/approve.ts <pattern>           # record as approved
 *   bun run scripts/approve.ts <pattern> --deny    # record as denied
 *   bun run scripts/approve.ts --list              # list pending patterns
 *   bun run scripts/approve.ts --cwd <dir> ...     # use a different project root
 *
 * The ledger lives at <cwd>/.claude-hooks/state/approvals.jsonl. The
 * permission-autopilot hook reads it on the next PermissionRequest for the
 * same pattern.
 */

import { Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"
import {
  Approvals,
  ApprovalsLive,
  type ApprovalRecord,
  type ApprovalStatus,
} from "../src/services/approvals.ts"
import { writeCliStderr, writeCliStdout } from "./io.ts"

interface ParsedArgs {
  readonly pattern: string | null
  readonly status: ApprovalStatus
  readonly cwd: string
  readonly list: boolean
  readonly help: boolean
}

const parseArgs = (argv: ReadonlyArray<string>): ParsedArgs => {
  let pattern: string | null = null
  let status: ApprovalStatus = "approved"
  let cwd = process.cwd()
  let list = false
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--deny") status = "denied"
    else if (a === "--approve") status = "approved"
    else if (a === "--list") list = true
    else if (a === "--help" || a === "-h") help = true
    else if (a === "--cwd") {
      const next = argv[i + 1]
      if (next === undefined) throw new Error("--cwd requires a value")
      cwd = path.resolve(next)
      i++
    } else if (a !== undefined && !a.startsWith("--") && pattern === null) {
      pattern = a
    } else if (a !== undefined) {
      throw new Error(`unknown argument: ${a}`)
    }
  }
  return { pattern, status, cwd, list, help }
}

const usage = `Usage:
  bun run scripts/approve.ts <pattern>           # record as approved
  bun run scripts/approve.ts <pattern> --deny    # record as denied
  bun run scripts/approve.ts --list              # list pending patterns
  bun run scripts/approve.ts --cwd <dir> ...     # use a different project root
`

const ledgerPath = (cwd: string): string =>
  path.join(cwd, ".claude-hooks", "state", "approvals.jsonl")

const listPending = (cwd: string): ReadonlyArray<ApprovalRecord> => {
  const file = ledgerPath(cwd)
  if (!fs.existsSync(file)) return []
  const raw = fs.readFileSync(file, "utf8")
  // Deduplicate to the latest record per pattern, then keep only those whose
  // latest status is "pending".
  const latest = new Map<string, ApprovalRecord>()
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    try {
      const v: unknown = JSON.parse(line)
      if (typeof v !== "object" || v === null) continue
      const r = v as Record<string, unknown>
      if (
        typeof r.cwd !== "string" ||
        typeof r.pattern !== "string" ||
        typeof r.recordedAt !== "number"
      )
        continue
      const status = r.status
      if (status !== "approved" && status !== "denied" && status !== "pending")
        continue
      const rec: ApprovalRecord = {
        cwd: r.cwd,
        pattern: r.pattern,
        status,
        recordedAt: r.recordedAt,
      }
      const key = `${rec.cwd}\x00${rec.pattern}`
      const cur = latest.get(key)
      if (cur === undefined || rec.recordedAt >= cur.recordedAt) latest.set(key, rec)
    } catch {
      // skip malformed
    }
  }
  return [...latest.values()].filter((r) => r.status === "pending")
}

export const main = async (argv: ReadonlyArray<string>): Promise<number> => {
  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (e) {
    writeCliStderr(`error: ${(e as Error).message}\n${usage}`)
    return 2
  }
  if (args.help) {
    writeCliStdout(usage)
    return 0
  }
  if (args.list) {
    const pending = listPending(args.cwd)
    if (pending.length === 0) {
      writeCliStdout("(no pending approvals)\n")
      return 0
    }
    for (const p of pending) {
      writeCliStdout(`${p.pattern}\n`)
    }
    return 0
  }
  if (args.pattern === null) {
    writeCliStderr(`error: missing <pattern>\n${usage}`)
    return 2
  }
  const record: ApprovalRecord = {
    cwd: args.cwd,
    pattern: args.pattern,
    status: args.status,
    recordedAt: Date.now(),
  }
  const program = Effect.gen(function* () {
    const approvals = yield* Approvals
    yield* approvals.record(record)
  }).pipe(Effect.provide(ApprovalsLive))
  await Effect.runPromise(program)
  writeCliStdout(
    `recorded ${record.status} for pattern ${record.pattern} in ${record.cwd}\n`,
  )
  return 0
}

// Top-level: run when invoked as a script. Bun sets import.meta.main.
const meta = import.meta as unknown as { main?: boolean }
if (meta.main === true) {
  const code = await main(process.argv.slice(2))
  process.exit(code)
}
