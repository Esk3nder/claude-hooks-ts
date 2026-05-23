import { Effect } from "effect"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import * as path from "node:path"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { NO_DECISION } from "../schema/decisions.ts"
import { FileSystem } from "../services/filesystem.ts"
import { SessionState, EMPTY_SESSION_STATE } from "../services/session-state.ts"
import { Project } from "../services/project.ts"
import { findLatestISA, findProjectIsa } from "../algorithm/isa/locate.ts"
import { parseSections } from "../algorithm/isa/sections.ts"
import { parseFrontmatter } from "../algorithm/isa/frontmatter.ts"
import { countCriteria } from "../algorithm/isa/criteria.ts"

const MAX_INJECT = 1024
const MAX_LIST = 20

interface IsaSnapshot {
  readonly path: string
  readonly kind: "project" | "task"
  readonly phase: string
  readonly progress: string
  readonly goalExcerpt: string
}

/**
 * Capture a compact snapshot of the active ISAs (project + latest task)
 * before compaction so the post-compact model can rehydrate identity even
 * after the conversation buffer is squashed. Goal excerpt is the first
 * paragraph of the `## Goal` section (per IsaFormat.md:217-228 the Goal is
 * the "tightest verbal form" — the highest-leverage thing to keep).
 */
const captureIsaSnapshot = (
  root: string,
  isaPath: string,
  kind: "project" | "task",
): IsaSnapshot | null => {
  if (!existsSync(isaPath)) return null
  let content: string
  try {
    content = readFileSync(isaPath, "utf-8")
  } catch {
    return null
  }
  const fm = parseFrontmatter(content) ?? {}
  const sections = parseSections(content)
  const goalBody = sections.get("Goal")?.body ?? ""
  // First paragraph (up to blank line) — keeps the snapshot terse.
  const firstPara = goalBody.split(/\n\n/, 1)[0]?.trim() ?? ""
  const counts = countCriteria(content)
  const computedProgress =
    counts.total > 0
      ? `${counts.checked}/${counts.total}`
      : (fm["progress"] ?? "0/0")
  return {
    path: isaPath,
    kind,
    phase: fm["phase"] ?? "(unknown)",
    progress: computedProgress,
    goalExcerpt:
      firstPara.length > 280
        ? `${firstPara.slice(0, 277)}...`
        : firstPara || "(no Goal section recorded)",
  }
  // Note: `root` is unused here but kept in the signature for symmetry
  // with the locate.ts helpers; future expansion (e.g. capturing relative
  // path display) will use it.
  void root
}

const collectIsas = (root: string): ReadonlyArray<IsaSnapshot> => {
  const out: IsaSnapshot[] = []
  const projectPath = findProjectIsa(root)
  if (projectPath !== null) {
    const snap = captureIsaSnapshot(root, projectPath, "project")
    if (snap !== null) out.push(snap)
  }
  const taskPath = findLatestISA(root)
  if (taskPath !== null && taskPath !== projectPath) {
    const snap = captureIsaSnapshot(root, taskPath, "task")
    if (snap !== null) out.push(snap)
  }
  return out
}

const fmtIsaSection = (isas: ReadonlyArray<IsaSnapshot>): string => {
  if (isas.length === 0) return "  (no ISAs found at project root or task work dir)"
  return isas
    .map(
      (s) =>
        `### ${s.kind} ISA — ${s.path}\n` +
        `- phase: ${s.phase}\n` +
        `- progress: ${s.progress}\n` +
        `- goal: ${s.goalExcerpt}`,
    )
    .join("\n\n")
}

const fmtIsaInline = (isas: ReadonlyArray<IsaSnapshot>): string => {
  if (isas.length === 0) return "(none)"
  return isas
    .map((s) => `${s.kind}@${s.path} [phase=${s.phase}, progress=${s.progress}]`)
    .join(" | ")
}

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, Math.max(0, max - 3)) + "..."

const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9._-]/g, "_")

const sanitizeTag = (s: string): string =>
  sanitize(s.toLowerCase())
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown"

const slugifyCustomInstructions = (s: string): string => {
  const words = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0)

  const picked: string[] = []
  let total = 0
  for (const word of words) {
    const next = picked.length === 0 ? word.length : word.length + 1
    if (total + next > 20) break
    picked.push(word)
    total += next
  }

  return picked.join("_") || "none"
}

const customInstructionsTag = (customInstructions: string | undefined): string => {
  const raw = customInstructions?.trim() ?? ""
  if (raw.length === 0) return "none"
  const slug = slugifyCustomInstructions(raw)
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 8)
  return `${slug}-${hash}`
}

export const handlePreCompact = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, FileSystem | SessionState | Project> =>
  Effect.gen(function* () {
    if (payload._tag !== "PreCompact") return NO_DECISION
    const fs = yield* FileSystem
    const state = yield* SessionState
    const project = yield* Project

    const root = yield* project.root()
    const record = yield* state
      .get(payload.session_id)
      .pipe(Effect.catchAll(() => Effect.succeed(EMPTY_SESSION_STATE)))

    const goal = record.next_required_action ?? "(no explicit goal recorded)"
    const filesChanged = record.files_changed
    const metaArtifactsChanged = record.meta_artifacts_changed
    const filesRead = record.files_read
    const commands = record.commands_run
    const failures = record.commands_failed
    const tests = record.tests_run
    const sources = record.source_urls

    const ts = Date.now()
    const tsIso = new Date(ts).toISOString()
    const safeId = sanitize(payload.session_id)
    const safeTrigger = sanitizeTag(payload.trigger ?? "unknown")
    const safeInstructions = customInstructionsTag(payload.custom_instructions)
    const safeTs = sanitize(tsIso)
    const snapshotPath = path.join(
      root,
      ".claude-hooks",
      "state",
      "compact-snapshots",
      `${safeId}-${safeTrigger}-${safeInstructions}-${safeTs}.md`,
    )

    const fmtList = (xs: ReadonlyArray<string>): string =>
      xs.length === 0
        ? "  (none)"
        : xs.map((x) => `  - ${x}`).join("\n")

    const isas = collectIsas(root)

    const md = [
      "# Pre-compact preservation snapshot",
      "",
      `- session_id: ${payload.session_id}`,
      `- timestamp: ${tsIso}`,
      `- trigger: ${payload.trigger ?? "unknown"}`,
      "",
      "## Active ISAs",
      fmtIsaSection(isas),
      "",
      "## Goal / next required action",
      goal,
      "",
      "## Verification status",
      record.verification_status,
      "",
      "## Files changed",
      fmtList(filesChanged),
      "",
      "## Hook meta-artifacts changed",
      fmtList(metaArtifactsChanged),
      "",
      "## Files read",
      fmtList(filesRead),
      "",
      "## Commands run",
      fmtList(commands),
      "",
      "## Failures",
      fmtList(failures),
      "",
      "## Tests run",
      fmtList(tests),
      "",
      "## Source URLs",
      fmtList(sources),
      "",
      "## Custom instructions",
      payload.custom_instructions ?? "(none)",
      "",
    ].join("\n")

    // mkdir parent — fs.writeFile (node) does not auto-create. Pre-existing
    // bug: snapshots silently failed in fresh installs without prior state dir.
    try {
      mkdirSync(path.dirname(snapshotPath), { recursive: true })
    } catch {
      // best-effort
    }
    yield* fs
      .writeFile(snapshotPath, md)
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)))

    const head = (xs: ReadonlyArray<string>): string =>
      xs.length === 0
        ? "(none)"
        : xs.length <= MAX_LIST
          ? xs.join(", ")
          : `${xs.slice(0, MAX_LIST).join(", ")} (+${xs.length - MAX_LIST} more)`

    const lines = [
      "Preservation context (pre-compact):",
      `- goal/next: ${goal}`,
      `- active_isas: ${fmtIsaInline(isas)}`,
      `- files_changed: ${head(filesChanged)}`,
      `- meta_artifacts_changed: ${head(metaArtifactsChanged)}`,
      `- commands_run: ${head(commands)}`,
      `- failures: ${head(failures)}`,
      `- verification: ${record.verification_status}`,
      `- snapshot: ${snapshotPath}`,
    ]
    const additionalContext = truncate(lines.join("\n"), MAX_INJECT)

    const out: HookDecision = {
      hookSpecificOutput: {
        hookEventName: "PreCompact",
        additionalContext,
      },
    }
    return out
  })
