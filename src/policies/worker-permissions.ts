import { Effect, Option, Schema } from "effect"
import * as path from "node:path"
import {
  BashInput,
  EditInput,
  GlobInput,
  GrepInput,
  MultiEditInput,
  ReadInput,
  WriteInput,
} from "../schema/tool-inputs.ts"
import type { PreToolUse } from "../schema/payloads.ts"
import type { PolicyDecision } from "./types.ts"
import { evaluateDestructiveCommand } from "./destructive-commands.ts"
import {
  expandPathMatchCandidates,
  globToRegExp,
  normalizePathPattern,
} from "./path-utils.ts"
import { lookupRole } from "./subagent-roles.ts"
import { durationMillis, loadRuntimeConfig } from "../services/runtime-config.ts"
import { splitShellWords } from "../services/shell-words.ts"
import { WorkerRuns, scopedWorkerRunId, type WorkerRunsApi } from "../services/worker-runs.ts"
import type { WorkerRun } from "../schema/worker-run.ts"

type PreToolUsePayload = Schema.Schema.Type<typeof PreToolUse>

const WRITE_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "TodoWrite",
])

const PASSTHROUGH: PolicyDecision = { kind: "passthrough" }

const MUTATING_GIT_RE =
  /\bgit\s+(?:add|am|apply|bisect|checkout|cherry-pick|clean|commit|merge|mv|pull|push|rebase|reset|restore|revert|rm|stash|switch)\b/i

const SHELL_WRITE_RE =
  /(^|[\s;&|()])(?:cat|printf|echo|sed|perl|python(?:3)?|node|bun|deno|tee|touch|mv|cp|install|chmod|chown)\b[\s\S]*(?:>{1,2}|-i\b|\bwriteFile(?:Sync)?\b|\bappendFile(?:Sync)?\b)|(?:^|[\s;&|()])(?:tee|touch|mv|cp|install|chmod|chown)\b/i

const READ_ONLY_BASH_ALLOWED_RE =
  /^(?:pwd|true|false|git\s+rev-parse\s+(?:--show-toplevel|--git-dir|--is-inside-work-tree|--abbrev-ref\s+HEAD)|git\s+branch(?:\s+(?:--show-current|--list))?|git\s+status(?:\s+(?:--short|--porcelain(?:=[A-Za-z0-9]+)?))?(?:\s+--\s+.+)?|git\s+ls-files(?:\s+--\s+.+)?)$/

const WHOLE_REPO_BASH_RE = /^git\s+(?:status|ls-files)(?:\s|$)/

const FIND_MUTATION_RE = /(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fls|fprint|fprintf)(?:\s|$)/i

const isActiveWorker = (run: WorkerRun): boolean =>
  run.status === "queued" || run.status === "running" || run.status === "blocked"

const MISSING_OUTPUT_BLOCK_RE = /\bworker output was missing\b/i

const isRecoverableMissingOutputShrapnel = (run: WorkerRun): boolean =>
  run.status === "blocked" && MISSING_OUTPUT_BLOCK_RE.test(run.blocked_reason ?? "")

/**
 * P1-4: a run is considered stale-by-TTL when it's still in an
 * active status (queued/running/blocked) AND its most relevant
 * timestamp is older than `staleAfterMs`. Workers that never emit
 * SubagentStop would otherwise age indefinitely — the supervisor's
 * `attempt` Effect has its own `Effect.timeoutFail`, but that
 * timeout only catches workers spawned via the supervisor path.
 * SubagentStart-tracked workers (claude-launched subagents) have no
 * internal timeout; without this sweep a dropped stop event leaves
 * the run record `running` for the rest of the session.
 *
 * The relevant timestamp:
 *   - `running` / `blocked` → started_at (when the worker began its
 *     attempt). The most precise upper bound on "should be done by
 *     now."
 *   - `queued` → created_at (queued workers have no `started_at`;
 *     a perma-queued worker is also stale-by-TTL because the queue
 *     should have picked it up long ago).
 *
 * Both timestamps are stringly-typed ISO-8601; we parse with `Date`
 * and treat NaN as "not stale" so a malformed record doesn't get
 * wrongly cancelled.
 */
const isStaleByTtl = (
  run: WorkerRun,
  nowMs: number,
  staleAfterMs: number,
): boolean => {
  if (!isActiveWorker(run)) return false
  const tsString =
    run.status === "queued" ? run.created_at : (run.started_at ?? run.created_at)
  const ts = Date.parse(tsString)
  if (!Number.isFinite(ts)) return false
  return nowMs - ts > staleAfterMs
}

const hasShellControlOperator = (command: string): boolean =>
  /(?:&&|\|\||;|\||>|<|`|\$\(|\n|\r)/.test(command)

const isPackageWorkerCliCommand = (command: string): boolean => {
  const normalized = command.replace(/\s+/g, " ").trim()
  if (normalized.length === 0 || hasShellControlOperator(normalized)) return false
  const words = splitShellWords(normalized)
  const commandName = words[0]
  if (commandName === undefined) return false
  const basename = path.basename(commandName)
  if (basename === "claude-hooks-workers") return true
  if (basename !== "bun" || words[1] !== "run") return false
  const script = words[2]?.replace(/\\/g, "/")
  return script === "scripts/workers.ts" || script?.endsWith("/scripts/workers.ts") === true
}

const isAllowlistedReadOnlyBash = (command: string): boolean => {
  const normalized = command.replace(/\s+/g, " ").trim()
  if (/^find(?:\s|$)/.test(normalized) && FIND_MUTATION_RE.test(normalized)) {
    return false
  }
  return normalized.length > 0 &&
    !hasShellControlOperator(normalized) &&
    READ_ONLY_BASH_ALLOWED_RE.test(normalized)
}

const workerScopeIsGlobal = (scope: string): boolean =>
  scopeGlobs(scope).includes("**/*")

const hasWorkerScope = (scope: string): boolean =>
  scopeGlobs(scope).length > 0

const patternHasPathScope = (pattern: string): boolean =>
  path.isAbsolute(pattern) ||
  pattern.includes("/") ||
  pattern.includes("\\") ||
  pattern.startsWith(".")

const patternScopeTarget = (basePath: string | undefined, pattern: string | undefined): string => {
  const base = basePath?.trim()
  const glob = pattern?.trim()
  if (base !== undefined && base.length > 0) {
    if (glob !== undefined && glob.length > 0) {
      return path.posix.join(base.replace(/\\/g, "/"), glob.replace(/\\/g, "/"))
    }
    return base
  }
  if (glob !== undefined && glob.length > 0 && patternHasPathScope(glob)) return glob
  return "."
}

const dashDashPathspecs = (command: string): ReadonlyArray<string> => {
  const marker = command.indexOf(" -- ")
  if (marker < 0) return []
  return command
    .slice(marker + 4)
    .split(/\s+/)
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ""))
    .filter((part) => part.length > 0)
}

const bashScopeDecision = (
  run: WorkerRun,
  command: string,
  cwd: string,
): PolicyDecision | null => {
  const normalized = command.replace(/\s+/g, " ").trim()
  if (!hasWorkerScope(run.scope)) return null
  if (!WHOLE_REPO_BASH_RE.test(normalized) || workerScopeIsGlobal(run.scope)) {
    return null
  }
  const pathspecs = dashDashPathspecs(normalized)
  if (pathspecs.length === 0) {
    return {
      kind: "deny",
      reason:
        `Worker ${run.worker_id} (${run.agent_type}) cannot run whole-repo Bash inspection outside assigned scope ${run.scope}.`,
    }
  }
  for (const pathspec of pathspecs) {
    const directoryProbe = `${pathspec.replace(/\/$/, "")}/__claude_hooks_scope_probe__`
    if (
      !pathInWorkerScope(run.scope, cwd, pathspec) &&
      !pathInWorkerScope(run.scope, cwd, directoryProbe)
    ) {
      return {
        kind: "deny",
        reason:
          `Worker ${run.worker_id} (${run.agent_type}) cannot run Bash inspection outside assigned scope ${run.scope}: ${pathspec}.`,
      }
    }
  }
  return null
}

const bashMutationDecision = (command: string): PolicyDecision => {
  const destructive = evaluateDestructiveCommand(command)
  if (destructive.kind === "deny" || destructive.kind === "ask") return destructive
  if (MUTATING_GIT_RE.test(command.replace(/\s+/g, " ").trim())) {
    return {
      kind: "deny",
      reason: "git mutation is not allowed for read-only or uncorrelated worker tool use.",
    }
  }
  const normalized = command.replace(/\s+/g, " ").trim()
  if (
    /\bgit\s+branch\b/i.test(normalized) &&
    !/^git\s+branch(?:\s+(?:--show-current|--list))?$/i.test(normalized)
  ) {
    return {
      kind: "deny",
      reason: "git branch mutation is not allowed for read-only or uncorrelated worker tool use.",
    }
  }
  if (SHELL_WRITE_RE.test(command)) {
    return {
      kind: "ask",
      reason: "Bash appears to mutate files; worker-scoped writes must use Edit/Write/MultiEdit for path enforcement.",
    }
  }
  return PASSTHROUGH
}

/**
 * P1-4: extended to also cancel stale-by-TTL runs (in addition to
 * the original "worker output was missing" recoverable shrapnel).
 * Each candidate carries the cancel reason it should receive so the
 * ledger preserves *why* the sweep fired.
 */
interface SweepCandidate {
  readonly run: WorkerRun
  readonly reason: string
}

const STALE_BY_TTL_GRACE_MS = 60_000

const cancelRecoverableWorkerShrapnel = (
  runs: WorkerRunsApi,
  activeRuns: ReadonlyArray<WorkerRun>,
  ttl: { readonly nowMs: number; readonly staleAfterMs: number } | undefined = undefined,
): Effect.Effect<ReadonlyArray<WorkerRun>> =>
  Effect.gen(function* () {
    const candidates: SweepCandidate[] = []
    for (const run of activeRuns) {
      if (isRecoverableMissingOutputShrapnel(run)) {
        candidates.push({
          run,
          reason: "worker stopped without output; treating as cancelled",
        })
        continue
      }
      if (ttl !== undefined && isStaleByTtl(run, ttl.nowMs, ttl.staleAfterMs)) {
        candidates.push({
          run,
          reason: `worker exceeded stale-by-TTL threshold (${ttl.staleAfterMs}ms) in status=${run.status}; treating as cancelled`,
        })
      }
    }
    if (candidates.length === 0) return activeRuns
    const outcomes = yield* Effect.forEach(
      candidates,
      (candidate) =>
        runs.cancel(candidate.run.worker_id, candidate.reason).pipe(Effect.either),
      { concurrency: "unbounded" },
    )
    const cancelledIds = new Set<string>()
    for (let index = 0; index < candidates.length; index += 1) {
      if (outcomes[index]?._tag === "Right") cancelledIds.add(candidates[index]!.run.worker_id)
    }
    return activeRuns.filter((run) => !cancelledIds.has(run.worker_id))
  })

const failClosedForUncorrelatedWrite = (
  payload: PreToolUsePayload,
  activeRuns: ReadonlyArray<WorkerRun>,
): PolicyDecision => {
  if (!activeRuns.some(isActiveWorker)) return PASSTHROUGH
  if (WRITE_TOOLS.has(payload.tool_name)) {
    return {
      kind: "deny",
      reason:
        `Write-capable tool ${payload.tool_name} had no worker correlation while active workers exist in this session.`,
    }
  }
  if (payload.tool_name !== "Bash") return PASSTHROUGH
  const decoded = Schema.decodeUnknownEither(BashInput)(payload.tool_input)
  if (decoded._tag === "Left") {
    return {
      kind: "ask",
      reason: "Bash input had no worker correlation and could not be decoded while active workers exist.",
    }
  }
  if (isPackageWorkerCliCommand(decoded.right.command)) return PASSTHROUGH
  if (
    isAllowlistedReadOnlyBash(decoded.right.command) &&
    !WHOLE_REPO_BASH_RE.test(decoded.right.command.replace(/\s+/g, " ").trim())
  ) {
    return PASSTHROUGH
  }
  const mutation = bashMutationDecision(decoded.right.command)
  return {
    kind: "deny",
    reason:
      mutation.kind === "passthrough"
        ? "Bash had no worker correlation while active workers exist; only allowlisted read-only inspection commands are allowed."
        : `Bash had no worker correlation while active workers exist: ${mutation.reason}`,
  }
}

const firstNonBlank = (
  ...values: ReadonlyArray<string | undefined>
): string | undefined => {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value
  }
  return undefined
}

export const workerIdForToolPayload = (
  payload: PreToolUsePayload,
): string | undefined => {
  const ids = workerCorrelationIdsForToolPayload(payload)
  return firstNonBlank(ids.workerId, ids.agentId, ids.taskId)
}

const workerCorrelationIdsForToolPayload = (
  payload: PreToolUsePayload,
): {
  readonly workerId?: string
  readonly agentId?: string
  readonly taskId?: string
} => {
  const extended = payload as PreToolUsePayload & {
    readonly worker_id?: string
    readonly agent_id?: string
    readonly task_id?: string
  }
  const workerId = firstNonBlank(extended.worker_id)
  const agentId = firstNonBlank(extended.agent_id)
  const taskId = firstNonBlank(extended.task_id)
  return {
    ...(workerId === undefined ? {} : { workerId }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(taskId === undefined ? {} : { taskId }),
  }
}

const bashDecisionForReadOnlyWorker = (
  run: WorkerRun,
  input: unknown,
  cwd: string,
): PolicyDecision => {
  const decoded = Schema.decodeUnknownEither(BashInput)(input)
  if (decoded._tag === "Left") {
    return {
      kind: "ask",
      reason: `Worker ${run.worker_id} (${run.agent_type}) is read-only; Bash input could not be decoded for safety review.`,
    }
  }
  if (isPackageWorkerCliCommand(decoded.right.command)) return PASSTHROUGH
  const mutation = bashMutationDecision(decoded.right.command)
  if (mutation.kind === "deny" || mutation.kind === "ask") {
    return {
      kind: "deny",
      reason: `Worker ${run.worker_id} (${run.agent_type}) is read-only; ${mutation.reason}`,
    }
  }
  if (!isAllowlistedReadOnlyBash(decoded.right.command)) {
    return {
      kind: "deny",
      reason:
        `Worker ${run.worker_id} (${run.agent_type}) is read-only; Bash is limited to allowlisted read-only inspection commands.`,
    }
  }
  const scoped = bashScopeDecision(run, decoded.right.command, cwd)
  if (scoped !== null) return scoped
  return PASSTHROUGH
}

const failClosedForStateUnavailable = (
  payload: PreToolUsePayload,
  workerId?: string,
): PolicyDecision => {
  const workerLabel = workerId === undefined ? "worker" : `worker ${workerId}`
  if (WRITE_TOOLS.has(payload.tool_name)) {
    return {
      kind: "deny",
      reason:
        `Could not verify ${workerLabel} permissions; write-capable tool ${payload.tool_name} is blocked fail-closed.`,
    }
  }
  if (payload.tool_name !== "Bash") return PASSTHROUGH
  const decoded = Schema.decodeUnknownEither(BashInput)(payload.tool_input)
  if (decoded._tag === "Left") {
    return {
      kind: "ask",
      reason: `Could not verify ${workerLabel} permissions; Bash input could not be decoded.`,
    }
  }
  if (isPackageWorkerCliCommand(decoded.right.command)) return PASSTHROUGH
  const mutation = bashMutationDecision(decoded.right.command)
  if (mutation.kind === "passthrough" && isAllowlistedReadOnlyBash(decoded.right.command)) {
    return PASSTHROUGH
  }
  return {
    kind: "deny",
    reason: `Could not verify ${workerLabel} permissions; Bash is blocked fail-closed.`,
  }
}

const writePathFor = (
  toolName: string,
  input: unknown,
): string | null => {
  if (toolName === "Edit") {
    const decoded = Schema.decodeUnknownEither(EditInput)(input)
    return decoded._tag === "Right" ? decoded.right.file_path : null
  }
  if (toolName === "Write") {
    const decoded = Schema.decodeUnknownEither(WriteInput)(input)
    return decoded._tag === "Right" ? decoded.right.file_path : null
  }
  if (toolName === "MultiEdit") {
    const decoded = Schema.decodeUnknownEither(MultiEditInput)(input)
    return decoded._tag === "Right" ? decoded.right.file_path : null
  }
  return null
}

const readPathsFor = (
  toolName: string,
  input: unknown,
): ReadonlyArray<string> | null => {
  if (toolName === "Read") {
    const decoded = Schema.decodeUnknownEither(ReadInput)(input)
    return decoded._tag === "Right" ? [decoded.right.file_path] : null
  }
  if (toolName === "Glob") {
    const decoded = Schema.decodeUnknownEither(GlobInput)(input)
    return decoded._tag === "Right"
      ? [patternScopeTarget(decoded.right.path, decoded.right.pattern)]
      : null
  }
  if (toolName === "Grep") {
    const decoded = Schema.decodeUnknownEither(GrepInput)(input)
    return decoded._tag === "Right"
      ? [patternScopeTarget(decoded.right.path, decoded.right.glob)]
      : null
  }
  if (toolName === "LS") {
    if (typeof input === "object" && input !== null) {
      const candidate = (input as { path?: unknown }).path
      return typeof candidate === "string" && candidate.length > 0 ? [candidate] : ["."]
    }
    return ["."]
  }
  return []
}

const scopeGlobs = (scope: string): ReadonlyArray<string> => {
  const proseTokens = new Set([
    "scope",
    "file",
    "files",
    "path",
    "paths",
    "only",
    "within",
    "under",
    "and",
    "or",
    "read-only",
    "write",
    "write-allowed",
  ])
  const tokens = scope
    .split(/[,\s]+/)
    .map((token) => token.trim().replace(/^[-*`'"]+|[`'".]+$/g, ""))
    .filter((token) => token.length > 0)
  const globs: string[] = []
  for (const token of tokens) {
    const normalizedToken = token.replace(/[;:]$/, "")
    if (proseTokens.has(normalizedToken.toLowerCase())) continue
    if (normalizedToken === "." || normalizedToken === "./" || normalizedToken === "**" || normalizedToken === "**/*") {
      globs.push("**/*")
      continue
    }
    const normalized = normalizePathPattern(normalizedToken)
    if (normalized.length === 0) continue
    globs.push(normalized)
    if (!/[*.?[\]{}]/.test(normalized) && !path.extname(normalized)) {
      globs.push(`${normalized.replace(/\/$/, "")}/**`)
    }
  }
  return globs
}

export const pathInWorkerScope = (
  scope: string,
  cwd: string,
  filePath: string,
): boolean => {
  const globs = scopeGlobs(scope)
  if (globs.length === 0) return false
  if (globs.includes("**/*")) return true
  const normalizedFilePath = normalizePathPattern(filePath)
  if (normalizedFilePath === ".") {
    const normalizedCwd = normalizePathPattern(cwd)
    if (
      globs.some((glob) => {
        const staticPrefix = (glob.split(/[*.?[\]{}]/, 1)[0] ?? "")
          .replace(/\/+$/, "")
        return staticPrefix.length > 0 &&
          (normalizedCwd === staticPrefix || normalizedCwd.endsWith(`/${staticPrefix}`))
      })
    ) {
      return true
    }
  }
  const candidates = expandPathMatchCandidates(cwd, [filePath])
  return candidates.some((candidate) =>
    globs.some((glob) => globToRegExp(glob).test(normalizePathPattern(candidate))),
  )
}

const evaluateRunToolUse = (
  run: WorkerRun,
  payload: PreToolUsePayload,
): PolicyDecision => {
  const role = lookupRole(run.agent_type)
  const conservativeReadOnly = run.mode === "read-only" || role.mode === "read-only" || role.mode === "unknown"
  if (conservativeReadOnly) {
    if (WRITE_TOOLS.has(payload.tool_name)) {
      return {
        kind: "deny",
        reason: `Worker ${run.worker_id} (${run.agent_type}) is read-only and cannot use ${payload.tool_name}.`,
      }
    }
    if (payload.tool_name === "Bash") {
      const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0
        ? payload.cwd
        : process.cwd()
      return bashDecisionForReadOnlyWorker(run, payload.tool_input, cwd)
    }
    const readPaths = readPathsFor(payload.tool_name, payload.tool_input)
    if (readPaths === null) {
      return {
        kind: "ask",
        reason: `Worker ${run.worker_id} (${run.agent_type}) read input could not be decoded for scope enforcement.`,
      }
    }
    const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0
      ? payload.cwd
      : process.cwd()
    if (!hasWorkerScope(run.scope)) return PASSTHROUGH
    for (const readPath of readPaths) {
      if (!pathInWorkerScope(run.scope, cwd, readPath)) {
        return {
          kind: "deny",
          reason: `Worker ${run.worker_id} (${run.agent_type}) cannot read outside assigned scope ${run.scope}: ${readPath}.`,
        }
      }
    }
    return PASSTHROUGH
  }

  if (payload.tool_name === "Bash") {
    const decoded = Schema.decodeUnknownEither(BashInput)(payload.tool_input)
    if (decoded._tag === "Left") {
      return {
        kind: "ask",
        reason: `Worker ${run.worker_id} (${run.agent_type}) Bash input could not be decoded for scope enforcement.`,
      }
    }
    if (isPackageWorkerCliCommand(decoded.right.command)) return PASSTHROUGH
    if (isAllowlistedReadOnlyBash(decoded.right.command)) {
      const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0
        ? payload.cwd
        : process.cwd()
      const scoped = bashScopeDecision(run, decoded.right.command, cwd)
      return scoped ?? PASSTHROUGH
    }
    const mutation = bashMutationDecision(decoded.right.command)
    return {
      kind: mutation.kind === "passthrough" ? "ask" : "deny",
      reason:
        mutation.kind === "passthrough"
          ? `Worker ${run.worker_id} (${run.agent_type}) Bash command is not in the read-only allowlist; confirm because scope cannot be enforced for shell commands.`
          : `Worker ${run.worker_id} (${run.agent_type}) cannot use mutating Bash because scope cannot be enforced: ${mutation.reason}`,
    }
  }

  const readPaths = readPathsFor(payload.tool_name, payload.tool_input)
  if (readPaths === null) {
    return {
      kind: "ask",
      reason: `Worker ${run.worker_id} (${run.agent_type}) read input could not be decoded for scope enforcement.`,
    }
  }
  const filePath = writePathFor(payload.tool_name, payload.tool_input)
  if (!WRITE_TOOLS.has(payload.tool_name)) {
    const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0
      ? payload.cwd
      : process.cwd()
    if (!hasWorkerScope(run.scope)) return PASSTHROUGH
    for (const readPath of readPaths) {
      if (!pathInWorkerScope(run.scope, cwd, readPath)) {
        return {
          kind: "deny",
          reason: `Worker ${run.worker_id} (${run.agent_type}) cannot read outside assigned scope ${run.scope}: ${readPath}.`,
        }
      }
    }
    return PASSTHROUGH
  }
  if (filePath === null) {
    return {
      kind: "ask",
      reason: `Worker ${run.worker_id} (${run.agent_type}) write input could not be decoded for scope enforcement.`,
    }
  }
  const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0
    ? payload.cwd
    : process.cwd()
  if (!hasWorkerScope(run.scope)) {
    return {
      kind: "ask",
      reason: `Worker ${run.worker_id} (${run.agent_type}) has no assigned write scope; confirm ${payload.tool_name} before allowing writes.`,
    }
  }
  if (pathInWorkerScope(run.scope, cwd, filePath)) return PASSTHROUGH
  return {
    kind: "deny",
    reason: `Worker ${run.worker_id} (${run.agent_type}) cannot write outside assigned scope ${run.scope}: ${filePath}.`,
  }
}

export const evaluateWorkerToolPermission = (
  payload: PreToolUsePayload,
): Effect.Effect<PolicyDecision> =>
  Effect.gen(function* () {
    const config = yield* loadRuntimeConfig
    if (!config.workerEnforceReadOnlyRoles) return PASSTHROUGH
    const runs = yield* Effect.serviceOption(WorkerRuns)
    if (Option.isNone(runs)) return PASSTHROUGH
    const configuredWorkerId = Option.isSome(config.workerIdOverride)
      ? config.workerIdOverride.value
      : undefined
    const payloadIds = workerCorrelationIdsForToolPayload(payload)
    const payloadWorkerId = firstNonBlank(payloadIds.workerId, payloadIds.agentId, payloadIds.taskId)
    const workerId = payloadWorkerId ?? configuredWorkerId
    if (workerId === undefined) {
      const activeRunsResult = yield* runs.value
        .forSession(payload.session_id, 1_000)
        .pipe(Effect.either)
      if (activeRunsResult._tag === "Left") {
        return failClosedForStateUnavailable(payload)
      }
      // P1-4: broaden the sweep to also cancel stale-by-TTL runs.
      // The grace term protects workers that legitimately need close
      // to their full `workerDefaultTimeoutMs` window — sweep fires
      // only once the run has been active for longer than its
      // configured timeout *plus* a one-minute cushion.
      const activeRuns = yield* cancelRecoverableWorkerShrapnel(
        runs.value,
        activeRunsResult.right,
        {
          nowMs: Date.now(),
          staleAfterMs:
            durationMillis(config.workerDefaultTimeoutMs) +
            STALE_BY_TTL_GRACE_MS,
        },
      )
      return failClosedForUncorrelatedWrite(payload, activeRuns)
    }
    const scopedResult = yield* runs.value
      .get(scopedWorkerRunId(payload.session_id, workerId))
      .pipe(Effect.either)
    const directResult = yield* runs.value.get(workerId).pipe(Effect.either)
    const scoped = scopedResult._tag === "Right" ? scopedResult.right : null
    const directRaw = directResult._tag === "Right" ? directResult.right : null
    const direct = directRaw?.session_id === payload.session_id ? directRaw : null
    const agentResult =
      scoped === null && direct === null
        ? yield* runs.value.findByAgent(payload.session_id, workerId).pipe(Effect.either)
        : null
    if (
      scopedResult._tag === "Left" ||
      directResult._tag === "Left" ||
      agentResult?._tag === "Left"
    ) {
      return failClosedForStateUnavailable(payload, workerId)
    }
    const run = scoped ?? direct ?? agentResult?.right ?? null
    if (run === null) {
      if (
        configuredWorkerId === undefined &&
        payloadIds.workerId === undefined &&
        firstNonBlank(payloadIds.agentId, payloadIds.taskId) !== undefined
      ) {
        return PASSTHROUGH
      }
      return failClosedForStateUnavailable(payload, workerId)
    }
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      return failClosedForStateUnavailable(payload, workerId)
    }
    return evaluateRunToolUse(run, payload)
  }).pipe(
    Effect.withSpan("worker.permission", {
      attributes: {
        tool: payload.tool_name,
        worker_id: workerIdForToolPayload(payload) ?? "none",
      },
    }),
  )
