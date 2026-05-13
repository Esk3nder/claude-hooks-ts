import { Effect, Option, Schema } from "effect"
import * as path from "node:path"
import {
  BashInput,
  EditInput,
  MultiEditInput,
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
import { loadRuntimeConfig } from "../services/runtime-config.ts"
import { WorkerRuns } from "../services/worker-runs.ts"
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

const isActiveWorker = (run: WorkerRun): boolean =>
  run.status === "queued" || run.status === "running" || run.status === "blocked"

const bashMutationDecision = (command: string): PolicyDecision => {
  const destructive = evaluateDestructiveCommand(command)
  if (destructive.kind === "deny" || destructive.kind === "ask") return destructive
  if (MUTATING_GIT_RE.test(command.replace(/\s+/g, " ").trim())) {
    return {
      kind: "deny",
      reason: "git mutation is not allowed for read-only or uncorrelated worker tool use.",
    }
  }
  return PASSTHROUGH
}

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
  const mutation = bashMutationDecision(decoded.right.command)
  if (mutation.kind === "passthrough") return PASSTHROUGH
  return {
    kind: "deny",
    reason: `Bash had no worker correlation while active workers exist: ${mutation.reason}`,
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
  const extended = payload as PreToolUsePayload & {
    readonly worker_id?: string
    readonly agent_id?: string
    readonly task_id?: string
  }
  return firstNonBlank(extended.worker_id, extended.agent_id, extended.task_id)
}

const bashDecisionForReadOnlyWorker = (
  run: WorkerRun,
  input: unknown,
): PolicyDecision => {
  const decoded = Schema.decodeUnknownEither(BashInput)(input)
  if (decoded._tag === "Left") {
    return {
      kind: "ask",
      reason: `Worker ${run.worker_id} (${run.agent_type}) is read-only; Bash input could not be decoded for safety review.`,
    }
  }
  const mutation = bashMutationDecision(decoded.right.command)
  if (mutation.kind === "deny" || mutation.kind === "ask") {
    return {
      kind: "deny",
      reason: `Worker ${run.worker_id} (${run.agent_type}) is read-only; ${mutation.reason}`,
    }
  }
  return PASSTHROUGH
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

const scopeGlobs = (scope: string): ReadonlyArray<string> => {
  const tokens = scope
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
  const globs: string[] = []
  for (const token of tokens) {
    if (token === "." || token === "./" || token === "**" || token === "**/*") {
      globs.push("**/*")
      continue
    }
    if (token.includes("*") || token.includes("?") || token.includes("/") || token.includes(".")) {
      const normalized = normalizePathPattern(token.replace(/[;:]$/, ""))
      globs.push(normalized)
      if (!/[*.?[\]{}]/.test(normalized) && !path.extname(normalized)) {
        globs.push(`${normalized.replace(/\/$/, "")}/**`)
      }
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
  if (globs.length === 0) return true
  if (globs.includes("**/*")) return true
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
      return bashDecisionForReadOnlyWorker(run, payload.tool_input)
    }
    return PASSTHROUGH
  }

  if (!WRITE_TOOLS.has(payload.tool_name)) return PASSTHROUGH
  const filePath = writePathFor(payload.tool_name, payload.tool_input)
  if (filePath === null) {
    return {
      kind: "ask",
      reason: `Worker ${run.worker_id} (${run.agent_type}) write input could not be decoded for scope enforcement.`,
    }
  }
  const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0
    ? payload.cwd
    : process.cwd()
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
    const workerId = workerIdForToolPayload(payload)
    if (workerId === undefined) {
      const activeRuns = yield* runs.value
        .forSession(payload.session_id, 1_000)
        .pipe(Effect.catchAll(() => Effect.succeed([])))
      return failClosedForUncorrelatedWrite(payload, activeRuns)
    }
    const direct = yield* runs.value.get(workerId).pipe(Effect.catchAll(() => Effect.succeed(null)))
    const run =
      direct ??
      (yield* runs.value
        .findByAgent(payload.session_id, workerId)
        .pipe(Effect.catchAll(() => Effect.succeed(null))))
    if (run === null) return PASSTHROUGH
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      return PASSTHROUGH
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
