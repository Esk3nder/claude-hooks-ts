/**
 * Mandatory worker delegation gate (US-2).
 *
 * For confidently deep ALGORITHM sessions (classifier tier ≥ E4), direct
 * Write/Edit/MultiEdit/NotebookEdit and write-class Bash should ideally be
 * delegated to a `Task`/`Agent` worker so parallel subagent leverage —
 * advertised in the README — actually happens. This gate codifies that
 * preference.
 *
 * Three modes, none of which fire below tier E4:
 *
 *   - "off"       (default) — passthrough always. No behavior change.
 *   - "recommend" — when a direct write fires at tier ≥ E4 with no active
 *                   worker, return `ask` with a remediation hint. The user
 *                   (or downstream prompt) can decide whether to delegate.
 *   - "strict"    — same predicate, but `deny`. The model MUST launch a
 *                   Task before continuing.
 *
 * Release conditions:
 *   - mode === "off"
 *   - tier === null or tier < 4
 *   - tool is not a covered write tool
 *   - at least one worker is currently active (starts > stops)
 *
 * Pure decision function — no I/O. Counts come from `subagent_starts` /
 * `subagent_stops` arrays already maintained by `subagent-scope-gate.ts`.
 */

import type { PolicyDecision } from "./types.ts"

export type WorkerMandatoryMode = "off" | "recommend" | "strict"

export interface WorkerMandatoryInput {
  readonly mode: WorkerMandatoryMode
  readonly toolName: string
  readonly lastTier: number | null
  readonly activeWorkerCount: number
  /** True when the current PreToolUse is happening inside a worker
   * (subagent) session — typically signalled by `CLAUDE_HOOKS_WORKER_ID`
   * being set (read via `RuntimeConfig.workerIdOverride`). The gate must
   * NEVER block a worker's own writes; the worker IS the delegation
   * target. Defaults to false (parent session). */
  readonly isWorkerSession?: boolean
}

/** Tool names that are subject to the gate when above E4.
 *
 * Intentionally absent:
 *   - `Task` / `Agent`: the delegation tools themselves. Gating them
 *     would defeat the gate's whole purpose.
 *   - `Bash`: handled by `destructive-commands` policy elsewhere; this
 *     gate only inspects toolName, not Bash commands, so adding "Bash"
 *     here would deny ALL Bash (including read-only inspection) which
 *     is too coarse.
 */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Update",
])

/** Bash write-class verbs, when toolName is "Bash" and we want to inspect
 * the command. Pure form takes only the toolName so far — callers that
 * want Bash-aware gating pass `toolName: "Bash"` AND should pre-resolve
 * whether the command is a write before invoking this evaluator. Keeping
 * the policy itself toolName-only matches engagement-gate / tdd-gate. */

export interface ActiveWorkerCounts {
  readonly starts: number
  readonly stops: number
}

export const activeWorkerCount = (counts: ActiveWorkerCounts): number =>
  Math.max(0, counts.starts - counts.stops)

const remediationHint =
  "This session is tier ≥ E4 and the gate is set to require delegation. " +
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
  // to do. Without this short-circuit, a worker classified at tier ≥ E4
  // (e.g., a long-spec worker prompt) would be unable to write anything.
  if (input.isWorkerSession === true) return { kind: "passthrough" }
  if (input.lastTier === null || input.lastTier < 4) {
    return { kind: "passthrough" }
  }
  if (!WRITE_TOOLS.has(input.toolName)) {
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
      reason: `worker-mandatory (recommend mode): ${remediationHint}`,
    }
  }
  // strict
  return {
    kind: "deny",
    reason: `worker-mandatory (strict mode): ${remediationHint}`,
  }
}
