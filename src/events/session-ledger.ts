import { Effect } from "effect"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { basename, dirname, join as pathJoin } from "node:path"
import * as path from "node:path"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { NO_DECISION } from "../schema/decisions.ts"
import { FileSystem } from "../services/filesystem.ts"
import { SessionState, EMPTY_SESSION_STATE } from "../services/session-state.ts"
import { Project } from "../services/project.ts"
import { findLatestISA, findProjectIsa } from "../algorithm/isa/locate.ts"
import { parseFrontmatter } from "../algorithm/isa/frontmatter.ts"
import { logWarning } from "../services/diagnostics.ts"

const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9._-]/g, "_")

interface ArchiveCandidate {
  readonly sourcePath: string
  readonly slug: string
  readonly archivePath: string
}

/**
 * Find ISAs that have transitioned to `phase: complete` and propose archive
 * destinations under `.claude-hooks/archive/<YYYY-MM-DD>/<slug>/ISA.md`.
 *
 * The archive lives OUTSIDE `.claude-hooks/state/` so completed-work
 * evidence is tracked in source control alongside the active task ISAs
 * under `.claude-hooks/work/`. Putting archives back under `state/`
 * would defeat the Option-B migration: active ISA gets tracked, then
 * the archived copy lands in ignored state and the trail is lost.
 *
 * Both project-root and latest task ISAs are considered; project ISAs
 * use "project" as the slug since they have no per-slug directory.
 *
 * Pure: reads files but does not write. The handler does the writes.
 */
const permissionBoundaryLines = (
  reason: string | undefined,
): ReadonlyArray<string> =>
  reason === "bypass_permissions_disabled"
    ? ["- permission_boundary: bypass_permissions_disabled"]
    : []

const findCompletedIsas = (root: string, dateIso: string): ArchiveCandidate[] => {
  const out: ArchiveCandidate[] = []
  const date = dateIso.slice(0, 10) // YYYY-MM-DD
  const considered: Array<{ path: string; slug: string }> = []

  const projectIsa = findProjectIsa(root)
  if (projectIsa !== null) {
    considered.push({ path: projectIsa, slug: "project" })
  }
  const taskIsa = findLatestISA(root)
  if (taskIsa !== null && taskIsa !== projectIsa) {
    // Task ISA path: <root>/.claude-hooks/work/<slug>/ISA.md (or the
    // legacy <root>/.claude-hooks/state/work/<slug>/ISA.md for in-flight
    // pre-migration sessions). Slug = the directory containing the file.
    const slug = basename(dirname(taskIsa))
    considered.push({ path: taskIsa, slug })
  }

  for (const { path: isaPath, slug } of considered) {
    if (!existsSync(isaPath)) continue
    let content: string
    try {
      content = readFileSync(isaPath, "utf-8")
    } catch {
      continue
    }
    const fm = parseFrontmatter(content)
    if (fm === null) continue
    const phase = (fm["phase"] ?? "").toLowerCase().trim()
    if (phase !== "complete") continue
    const archivePath = pathJoin(
      root,
      ".claude-hooks",
      "archive",
      date,
      slug,
      "ISA.md",
    )
    out.push({ sourcePath: isaPath, slug, archivePath })
  }
  return out
}

export const handleSessionEnd = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, FileSystem | SessionState | Project> =>
  Effect.gen(function* () {
    if (payload._tag !== "SessionEnd") return NO_DECISION
    const fs = yield* FileSystem
    const state = yield* SessionState
    const project = yield* Project

    const root = yield* project.root()
    const record = yield* state
      .get(payload.session_id)
      .pipe(Effect.catchAll(() => Effect.succeed(EMPTY_SESSION_STATE)))
    const ts = Date.now()
    const tsIso = new Date(ts).toISOString()
    const file = path.join(
      root,
      ".claude-hooks",
      "state",
      "sessions",
      `${sanitize(payload.session_id)}.md`,
    )

    const fmtList = (xs: ReadonlyArray<string>): string =>
      xs.length === 0 ? "  (none)" : xs.map((x) => `  - ${x}`).join("\n")

    const md = [
      "# Session summary",
      "",
      `- session_id: ${payload.session_id}`,
      `- ended_at: ${tsIso}`,
      `- reason: ${payload.reason ?? "(unspecified)"}`,
      ...permissionBoundaryLines(payload.reason),
      `- verification_status: ${record.verification_status}`,
      `- next_required_action: ${record.next_required_action ?? "(none)"}`,
      "",
      "## Files changed",
      fmtList(record.files_changed),
      "",
      "## Files read",
      fmtList(record.files_read),
      "",
      "## Commands run",
      fmtList(record.commands_run),
      "",
      "## Commands failed",
      fmtList(record.commands_failed),
      "",
      "## Tests run",
      fmtList(record.tests_run),
      "",
      "## Source URLs",
      fmtList(record.source_urls),
      "",
    ].join("\n")

    try {
      mkdirSync(path.dirname(file), { recursive: true })
    } catch {
      // best-effort
    }
    yield* fs
      .writeFile(file, md)
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)))

    // 3b: archive completed ISAs to state/archive/<YYYY-MM-DD>/<slug>/ISA.md
    // so completed work has a frozen historical record. Best-effort —
    // archive failures never block session end.
    const candidates = findCompletedIsas(root, tsIso)
    for (const c of candidates) {
      let content: string
      try {
        content = readFileSync(c.sourcePath, "utf-8")
      } catch {
        continue
      }
      try {
        mkdirSync(dirname(c.archivePath), { recursive: true })
      } catch {
        // best-effort
      }
      yield* fs
        .writeFile(c.archivePath, content)
        .pipe(
          Effect.catchAll((cause: unknown) => {
            const msg = String(cause).slice(0, 120)
            return logWarning(`session-ledger: archive failed for ${c.sourcePath}: ${msg}`)
          }),
        )
    }

    return NO_DECISION
  })
