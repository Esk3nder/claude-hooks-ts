/**
 * Mandatory worker delegation gate (US-2).
 *
 * For confidently deep ALGORITHM sessions (classifier tier ≥ configured
 * minimum, default E4), direct Write/Edit/MultiEdit/NotebookEdit and
 * write-class Bash should ideally be delegated to a `Task`/`Agent` worker
 * so parallel subagent leverage — advertised in the README — actually
 * happens. This gate codifies that preference.
 *
 * Three modes, none of which fire below the configured minimum tier:
 *
 *   - "off"       — passthrough always. No behavior change.
 *   - "recommend" — when a direct write fires at or above the configured
 *                   tier with no active worker, return `ask` with a
 *                   remediation hint. The user (or downstream prompt) can
 *                   decide whether to delegate.
 *   - "strict"    — same predicate, but `deny`. The model MUST launch a
 *                   Task before continuing.
 *
 * Release conditions:
 *   - mode === "off"
 *   - tier === null or tier < configured minimum tier
 *   - tool is not a covered write tool
 *   - at least one worker is currently active (starts > stops)
 *
 * Pure decision function — no I/O. Counts come from `subagent_starts` /
 * `subagent_stops` arrays already maintained by `subagent-scope-gate.ts`.
 */

import type { PolicyDecision } from "./types.ts"
import { isBashFileWrite } from "./write-class.ts"

export type WorkerMandatoryMode = "off" | "recommend" | "strict"

export interface WorkerMandatoryInput {
  readonly mode: WorkerMandatoryMode
  readonly toolName: string
  readonly lastTier: number | null
  /** Minimum ALGORITHM tier that triggers the gate. Defaults to E4. */
  readonly minTier?: number
  readonly activeWorkerCount: number
  /** True when the current PreToolUse is happening inside a worker
   * (subagent) session — typically signalled by `CLAUDE_HOOKS_WORKER_ID`
   * being set (read via `RuntimeConfig.workerIdOverride`). The gate must
   * NEVER block a worker's own writes; the worker IS the delegation
   * target. Defaults to false (parent session). */
  readonly isWorkerSession?: boolean
  /**
   * Enforcement-plane P0 #6: when `toolName === "Bash"`, the bash command
   * string. Used to detect heredoc-style file writes (`cat > x <<EOF`,
   * `tee`, `sed -i`, etc.) that bypassed worker-mandatory strict mode
   * before this field existed.
   *
   * Note on policy boundaries (P2-3 doc clarification): the
   * `destructive-commands` policy in `src/policies/destructive-commands.ts`
   * remains responsible for catching CATASTROPHIC Bash patterns
   * (`rm -rf /`, `git reset --hard`, `DROP DATABASE`, etc.) — it is
   * called independently from `pretool-policy.ts` and is NOT wired
   * through this gate. The two policies have complementary scopes:
   * `destructive-commands` answers "is this command obviously
   * destructive?"; this gate answers "should this write be delegated
   * to a worker at the configured tier?". A Bash command that writes a file
   * non-destructively (e.g., `tee out.txt`) wouldn't trip
   * `destructive-commands` but would trip this gate via
   * `isBashFileWrite(bashCommand)`.
   *
   * Optional for back-compat: callers that don't supply it preserve
   * the prior toolName-only behavior (Bash always passes through).
   */
  readonly bashCommand?: string
}

/** Direct-write tool names that are always subject to the gate when
 * at or above the configured minimum tier.
 *
 * Intentionally absent:
 *   - `Task` / `Agent`: the delegation tools themselves. Gating them
 *     would defeat the gate's whole purpose.
 *   - `Bash`: not in this set because not every Bash command is a write
 *     (read-only inspection like `ls` / `git status` must pass through).
 *     Bash-with-a-write-class-command is gated separately via the
 *     optional `bashCommand` field on `WorkerMandatoryInput` (see the
 *     `isBashFileWrite` check in the predicate below). Callers that
 *     want Bash-aware gating pass `toolName: "Bash"` AND `bashCommand:
 *     <command>`; the evaluator runs `isBashFileWrite` on the command
 *     and applies the same recommend/strict decision used for direct
 *     write tools.
 */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Update",
])

export interface ActiveWorkerCounts {
  readonly starts: number
  readonly stops: number
}

export const activeWorkerCount = (counts: ActiveWorkerCounts): number =>
  Math.max(0, counts.starts - counts.stops)

const DEFAULT_MIN_TIER = 4

const remediationHint = (minTier: number): string =>
  `This session is tier ≥ E${minTier} and the gate is set to require delegation. ` +
  "Launch a Task (or Agent) with the worker contract instead of writing " +
  "inline. See src/policies/worker-contract.ts for the output schema. " +
  "Once a worker is active (a SubagentStart event has fired) direct writes " +
  "are allowed again."

export const evaluateWorkerMandatoryGate = (
  input: WorkerMandatoryInput,
): PolicyDecision => {
  if (input.mode === "off") return { kind: "passthrough" }
  // Worker sessions are excluded — the gate exists to push PARENT
  // sessions toward delegating; once inside a worker, the model IS the
  // delegation target and direct writes are exactly what it was spawned
  // to do. Without this short-circuit, a worker classified at or above the
  // configured tier would be unable to write anything.
  if (input.isWorkerSession === true) return { kind: "passthrough" }
  const minTier = input.minTier ?? DEFAULT_MIN_TIER
  if (input.lastTier === null || input.lastTier < minTier) {
    return { kind: "passthrough" }
  }
  // Enforcement-plane P0 #6: Bash with a write-class command is treated
  // exactly like a direct write tool. Without this, the model could
  // bypass strict mode via `cat > src/x.ts <<EOF\n...\nEOF`.
  const isBashWriteClass =
    input.toolName === "Bash" &&
    typeof input.bashCommand === "string" &&
    isBashFileWrite(input.bashCommand)
  if (!WRITE_TOOLS.has(input.toolName) && !isBashWriteClass) {
    return { kind: "passthrough" }
  }
  if (input.activeWorkerCount > 0) {
    return {
      kind: "allow",
      reason: "worker-mandatory: a worker is currently active.",
    }
  }
  if (input.mode === "recommend") {
    return {
      kind: "ask",
      reason: `worker-mandatory (recommend mode): ${remediationHint(minTier)}`,
    }
  }
  // strict
  return {
    kind: "deny",
    reason: `worker-mandatory (strict mode): ${remediationHint(minTier)}`,
  }
}
