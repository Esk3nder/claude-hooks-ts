/**
 * Unified write-class tool surface. Single source of truth for "is this
 * tool a file-writing operation?" across the four enforcement modules
 * (pretool-policy, engagement-gate, worker-mandatory, post-edit-quality).
 *
 * Before this module existed, each module rolled its own definition.
 * The Opus diligence on 2026-05-20 confirmed three high-severity bypasses
 * resulting from the inconsistency:
 *   - `Update` / `NotebookEdit` skipped write-path policies (pretool-policy)
 *   - Unknown / MCP write tools passed through during pre-ISA engagement
 *   - Bash heredoc writes bypassed worker-mandatory strict
 *
 * The fix is structural: a single module any gate can import to get a
 * canonical answer. Adding a new write-class tool means changing ONE
 * file; the rest of the system picks it up automatically.
 */

/**
 * Tool names that directly mutate files via a typed Claude Code tool
 * input. Edit / Write / MultiEdit are the classics; Update is the
 * atomic in-place edit; NotebookEdit targets `.ipynb` files.
 */
export const WRITE_CLASS_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "Update",
  "NotebookEdit",
])

/**
 * Extract the mutable target path from a tool input, regardless of
 * which write tool produced the input. Edit/Write/MultiEdit/Update
 * carry `file_path`; NotebookEdit carries `notebook_path`. Returns
 * `null` when the input is the wrong shape (caller decides whether
 * that's a deny / ask / passthrough).
 */
export const mutablePathFromInput = (input: unknown): string | null => {
  if (typeof input !== "object" || input === null) return null
  const obj = input as { file_path?: unknown; notebook_path?: unknown }
  if (typeof obj.file_path === "string" && obj.file_path.length > 0) {
    return obj.file_path
  }
  if (
    typeof obj.notebook_path === "string" &&
    obj.notebook_path.length > 0
  ) {
    return obj.notebook_path
  }
  return null
}

/**
 * Bash-write-class patterns. When `toolName === "Bash"` and the command
 * matches one of these, treat the Bash invocation as write-class for
 * gate purposes (worker-mandatory in particular — without this, the
 * model can write any file via heredoc and skip the delegation gate).
 *
 * The list is intentionally broad: false-positives are cheap (user
 * confirms once or the gate's existing ask/deny flow runs); false-
 * negatives miss the entire point of worker-mandatory.
 *
 * NOT in scope here: catastrophic destructive patterns (rm -rf etc).
 * Those live in `destructive-commands.ts` and deny outright; this
 * module is "is this a mutation?", not "is this dangerous?".
 */
/**
 * `/dev/null`, `/dev/tty`, `/dev/stdout`, `/dev/stderr` are not real
 * files for our purposes — redirecting to them is suppression /
 * console output, not a filesystem mutation.
 */
const DEV_NULL_TARGET = /\/dev\/(?:null|tty|stdout|stderr)\b/

const BASH_WRITE_PATTERNS: ReadonlyArray<RegExp> = [
  // Redirect / append to a file. `[^<\n]*?` is non-greedy and explicitly
  // excludes `<` so heredocs (`cat > x <<EOF`) match the heredoc pattern
  // below, not this one. Exclusion of `/dev/null|tty|stdout|stderr`
  // happens via a runtime check below — regex lookahead would be brittle
  // when combined with the lead-in alternation.
  /(?:^|[;&|\s])(?:cat|echo|printf)\b[^<\n]*?>{1,2}\s*(\S+)/,
  // Heredoc INTO a redirect target (cat > file <<EOF, tee << <<EOF)
  /(?:^|[;&|\s])(?:cat|tee)\b[^<\n]*<<-?'?\w+'?/,
  // tee with no redirect-out is still a write (tee file or tee -a file)
  /(?:^|[;&|\s])tee\s+(?:-a\s+)?(\S+)/,
  // sed -i (in-place)
  /(?:^|[;&|\s])sed\s+-i(?:\s|\.|=|$)/,
  // perl -pi / perl -i / perl --in-place
  /(?:^|[;&|\s])perl\s+(?:-[a-zA-Z]*i[a-zA-Z]*|--in-place)(?:\s|$)/,
  // python -c with .write( or .write_text( anywhere in the command body
  /(?:^|[;&|\s])python\d?\b[\s\S]{0,500}?\.write(?:_text)?\(/,
  // node -e with writeFileSync / appendFileSync / fs.write*
  /(?:^|[;&|\s])node\b[\s\S]{0,500}?\b(?:writeFileSync|appendFileSync|createWriteStream)\b/,
  // cp / mv with at least one space between args (creates / overwrites
  // destination)
  /(?:^|[;&|\s])(?:cp|mv)\s+\S+\s+\S+/,
  // touch creates / updates mtime — write-class for our purposes
  /(?:^|[;&|\s])touch\s+\S+/,
  // git apply / git am modify the working tree
  /(?:^|[;&|\s])git\s+(?:apply|am)\b/,
  // dd output to a file (not /dev/null)
  /(?:^|[;&|\s])dd\s+[^|;&]*\bof=(\S+)/,
]

/**
 * Some patterns capture the redirect target. If the target is /dev/null,
 * /dev/tty, /dev/stdout, /dev/stderr, treat as console-only — not a
 * filesystem mutation.
 */
const isDevNullTarget = (target: string): boolean => DEV_NULL_TARGET.test(target)

/**
 * Does this Bash command write to the filesystem? Conservative — we'd
 * rather over-include than miss heredoc-shaped bypasses.
 *
 * Pure regex check; no parsing. Safe to call thousands of times.
 */
export const isBashFileWrite = (command: string): boolean => {
  if (typeof command !== "string" || command.length === 0) return false
  for (const re of BASH_WRITE_PATTERNS) {
    const m = re.exec(command)
    if (m === null) continue
    // If the pattern captured a target, check it's not /dev/null and
    // friends — those are console suppression, not file mutation.
    const target = m[1]
    if (target !== undefined && isDevNullTarget(target)) continue
    return true
  }
  return false
}

/**
 * Set of known read-only / introspection tools we never want flagged.
 * Exposed for callers (engagement-gate) that need to distinguish
 * "this is a known safe tool" from "this is an unknown tool we should
 * ask about".
 */
export const KNOWN_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebFetch",
  "WebSearch",
])

/**
 * Returns true when the toolName is NOT in any of our known categories
 * (write-class, read-only, the delegation tools, or Bash). Used by
 * engagement-gate to decide whether to `ask` before the model invokes
 * an MCP tool that might write before the ISA is scaffolded.
 *
 * `Bash`, `Task`, `Agent`, `TodoWrite`, and other dispatcher/control
 * tools that are neither read-class nor write-class are deliberately
 * NOT considered "unknown" — the engagement gate handles them via
 * dedicated branches.
 */
const DISPATCHER_AND_CONTROL_TOOLS: ReadonlySet<string> = new Set([
  "Bash",
  "Task",
  "Agent",
  "TodoWrite",
  "BashOutput",
  "KillShell",
  "ExitPlanMode",
])

export const isUnknownTool = (toolName: string): boolean => {
  if (WRITE_CLASS_TOOLS.has(toolName)) return false
  if (KNOWN_READ_ONLY_TOOLS.has(toolName)) return false
  if (DISPATCHER_AND_CONTROL_TOOLS.has(toolName)) return false
  return true
}
