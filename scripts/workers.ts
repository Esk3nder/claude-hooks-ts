#!/usr/bin/env bun
/**
 * claude-hooks-workers — bounded worker runtime observability.
 *
 * Usage:
 *   claude-hooks-workers list [--cwd <dir>] [--session <id>] [--limit <n>] [--json]
 *   claude-hooks-workers show <worker_id> [--cwd <dir>] [--json]
 *   claude-hooks-workers tail [--cwd <dir>] [--session <id>] [--limit <n>] [--json]
 *   claude-hooks-workers summary --session <id> [--cwd <dir>] [--json]
 *   claude-hooks-workers apply <worker_id> [--cwd <dir>] [--check] [--json]
 *   claude-hooks-workers cancel <worker_id> [--cwd <dir>] [--reason <text>] [--json]
 *   claude-hooks-workers retry <worker_id> --prompt <text> [--cwd <dir>] [--json]
 */

import { Effect, Layer } from "effect"
import * as path from "node:path"
import { EventStoreLive } from "../src/services/event-store.ts"
import { loadRuntimeConfig, RuntimeConfigLive } from "../src/services/runtime-config.ts"
import { WorkerQueue, WorkerQueueLive } from "../src/services/worker-queue.ts"
import { CommandRunnerPlatformLive } from "../src/services/command-runner.ts"
import { WorkerIntegration, WorkerIntegrationLive } from "../src/services/worker-integration.ts"
import {
  hashWorkerPrompt,
  WorkerRuns,
  WorkerRunsLive,
} from "../src/services/worker-runs.ts"
import { summarizeWorkerRuns } from "../src/services/worker-aggregation.ts"
import type { WorkerJobPayload, WorkerRun } from "../src/schema/worker-run.ts"
import type { WorkerJob } from "../src/schema/events.ts"
import { writeCliStderr, writeCliStdout } from "./io.ts"

type Command = "list" | "show" | "tail" | "summary" | "apply" | "cancel" | "retry" | "help"

interface Output {
  readonly stdout: (message: string) => void
  readonly stderr: (message: string) => void
}

interface ParsedArgs {
  readonly command: Command
  readonly cwd: string
  readonly workerId?: string
  readonly sessionId?: string
  readonly limit: number
  readonly json: boolean
  readonly checkOnly: boolean
  readonly reason: string
  readonly prompt?: string
}

const defaultOutput: Output = {
  stdout: writeCliStdout,
  stderr: writeCliStderr,
}

const usage = `Usage:
  claude-hooks-workers list [--cwd <dir>] [--session <id>] [--limit <n>] [--json]
  claude-hooks-workers show <worker_id> [--cwd <dir>] [--json]
  claude-hooks-workers tail [--cwd <dir>] [--session <id>] [--limit <n>] [--json]
  claude-hooks-workers summary --session <id> [--cwd <dir>] [--json]
  claude-hooks-workers apply <worker_id> [--cwd <dir>] [--check] [--json]
  claude-hooks-workers cancel <worker_id> [--cwd <dir>] [--reason <text>] [--json]
  claude-hooks-workers retry <worker_id> --prompt <text> [--cwd <dir>] [--json]
`

const commandFrom = (value: string | undefined): Command => {
  switch (value) {
    case undefined:
      return "list"
    case "list":
    case "show":
    case "tail":
    case "summary":
    case "apply":
    case "cancel":
    case "retry":
      return value
    case "--help":
    case "-h":
    case "help":
      return "help"
    default:
      throw new Error(`unknown command: ${value}`)
  }
}

const parsePositiveInt = (value: string | undefined, flag: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`)
  }
  return parsed
}

export const parseArgs = (argv: ReadonlyArray<string>): ParsedArgs => {
  const command = commandFrom(argv[0])
  let cwd = process.cwd()
  let workerId: string | undefined
  let sessionId: string | undefined
  let limit = 20
  let json = false
  let checkOnly = false
  let reason = "cancelled by operator"
  let prompt: string | undefined

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--cwd") {
      const next = argv[++i]
      if (next === undefined) throw new Error("--cwd requires a value")
      cwd = path.resolve(next)
    } else if (arg === "--session") {
      const next = argv[++i]
      if (next === undefined) throw new Error("--session requires a value")
      sessionId = next
    } else if (arg === "--limit") {
      limit = parsePositiveInt(argv[++i], "--limit")
    } else if (arg === "--json") {
      json = true
    } else if (arg === "--check") {
      checkOnly = true
    } else if (arg === "--reason") {
      const next = argv[++i]
      if (next === undefined) throw new Error("--reason requires a value")
      reason = next
    } else if (arg === "--prompt") {
      const next = argv[++i]
      if (next === undefined) throw new Error("--prompt requires a value")
      prompt = next
    } else if (arg !== undefined && !arg.startsWith("--") && workerId === undefined) {
      workerId = arg
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }

  if ((command === "show" || command === "apply" || command === "cancel" || command === "retry") && workerId === undefined) {
    throw new Error(`${command} requires <worker_id>`)
  }
  if (command === "summary" && sessionId === undefined) {
    throw new Error("summary requires --session <id>")
  }
  if (command === "retry" && prompt === undefined) {
    throw new Error("retry requires --prompt <text> because raw prompts are not persisted")
  }

  return {
    command,
    cwd,
    ...(workerId === undefined ? {} : { workerId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    limit,
    json,
    checkOnly,
    reason,
    ...(prompt === undefined ? {} : { prompt }),
  }
}

const dataLayer = (cwd: string) => {
  const eventBacked = Layer.provideMerge(
    Layer.mergeAll(WorkerQueueLive(cwd), WorkerRunsLive(cwd)),
    Layer.mergeAll(EventStoreLive, RuntimeConfigLive),
  )
  const integration = Layer.provide(
    WorkerIntegrationLive,
    Layer.mergeAll(eventBacked, CommandRunnerPlatformLive),
  )
  return Layer.mergeAll(eventBacked, integration)
}

const formatRun = (run: WorkerRun): string =>
  [
    run.worker_id,
    run.status,
    run.agent_type,
    run.mode,
    `session=${run.session_id}`,
    run.parent_task_id === undefined ? "" : `parent=${run.parent_task_id}`,
    `attempts=${run.attempts}`,
    run.integration_status === undefined ? "" : `integration=${run.integration_status}`,
    run.result?.summary === undefined ? "" : `summary=${run.result.summary}`,
    run.blocked_reason === undefined ? "" : `blocked=${run.blocked_reason}`,
    run.failure_reason === undefined || run.failure_reason === run.blocked_reason ? "" : `failure=${run.failure_reason}`,
  ].filter((part) => part.length > 0).join(" ")

const print = (out: Output, json: boolean, value: unknown, text: string): void => {
  out.stdout(json ? `${JSON.stringify(value, null, 2)}\n` : text)
}

const jobForRetry = (run: WorkerRun, prompt: string): WorkerJob => {
  const payload: WorkerJobPayload = {
    session_id: run.session_id,
    agent_type: run.agent_type,
    mode: run.mode,
    prompt,
    scope: run.scope,
    ...(run.parent_task_id === undefined ? {} : { parent_task_id: run.parent_task_id }),
    ...(run.agent_id === undefined ? {} : { agent_id: run.agent_id }),
    worker_id: run.worker_id,
  }
  return {
    id: run.worker_id,
    queue: "default",
    payload,
    enqueuedAt: Date.now(),
    attempts: run.attempts,
  }
}

const isActiveRun = (run: WorkerRun): boolean =>
  run.status === "queued" || run.status === "running" || run.status === "blocked"

export const runWorkersDetailed = async (
  argv: ReadonlyArray<string>,
  out: Output = defaultOutput,
): Promise<number> => {
  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (cause) {
    out.stderr(`error: ${(cause as Error).message}\n${usage}`)
    return 2
  }
  if (args.command === "help") {
    out.stdout(usage)
    return 0
  }

  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* WorkerRuns
        if (args.command === "show") {
          const run = yield* runs.get(args.workerId!)
          if (run === null) return { kind: "not-found" as const, workerId: args.workerId! }
          return { kind: "value" as const, value: run, text: `${formatRun(run)}\n` }
        }
        if (args.command === "cancel") {
          const run = yield* runs.cancel(args.workerId!, args.reason)
          return { kind: "value" as const, value: run, text: `${formatRun(run)}\n` }
        }
        if (args.command === "apply") {
          const integration = yield* WorkerIntegration
          const applied = yield* integration.applyWorkerPatch(args.workerId!, {
            checkOnly: args.checkOnly,
          })
          return { kind: "value" as const, value: applied, text: `${JSON.stringify(applied, null, 2)}\n` }
        }
        if (args.command === "retry") {
          const run = yield* runs.get(args.workerId!)
          if (run === null) return { kind: "not-found" as const, workerId: args.workerId! }
          const queue = yield* WorkerQueue
          const config = yield* loadRuntimeConfig
          const activeRuns = yield* runs.list(config.workerQueueCapacity + 1)
          if (activeRuns.filter(isActiveRun).length >= config.workerQueueCapacity) {
            return yield* Effect.fail(
              new Error(`worker queue capacity reached (${config.workerQueueCapacity})`),
            )
          }
          const queued = yield* runs.createQueued({
            worker_id: run.worker_id,
            session_id: run.session_id,
            ...(run.parent_task_id === undefined ? {} : { parent_task_id: run.parent_task_id }),
            ...(run.agent_id === undefined ? {} : { agent_id: run.agent_id }),
            agent_type: run.agent_type,
            mode: run.mode,
            prompt_hash: hashWorkerPrompt(args.prompt!),
            scope: run.scope,
          })
          yield* queue.offer(jobForRetry(queued, args.prompt!)).pipe(
            Effect.catchAll((cause) =>
              runs.cancel(queued.worker_id, `retry enqueue failed: ${String(cause)}`).pipe(
                Effect.catchAll(() => Effect.void),
                Effect.zipRight(Effect.fail(cause)),
              ),
            ),
          )
          return { kind: "value" as const, value: queued, text: `${formatRun(queued)}\n` }
        }
        if (args.command === "summary") {
          const sessionRuns = yield* runs.forSession(args.sessionId!, args.limit)
          const summary = summarizeWorkerRuns(args.sessionId!, sessionRuns)
          return { kind: "value" as const, value: summary, text: `${JSON.stringify(summary, null, 2)}\n` }
        }
        const listed = args.sessionId === undefined
          ? yield* runs.list(args.limit)
          : yield* runs.forSession(args.sessionId, args.limit)
        return {
          kind: "value" as const,
          value: listed,
          text: listed.map(formatRun).join("\n") + (listed.length > 0 ? "\n" : ""),
        }
      }).pipe(Effect.provide(dataLayer(args.cwd))),
    )
    if (result.kind === "not-found") {
      out.stderr(`worker not found: ${result.workerId}\n`)
      return 1
    }
    print(out, args.json, result.value, result.text)
    return 0
  } catch (cause) {
    out.stderr(`error: ${String(cause)}\n`)
    return 1
  }
}

export const main = (argv: ReadonlyArray<string>): Promise<number> =>
  runWorkersDetailed(argv)

const meta = import.meta as unknown as { main?: boolean }
if (meta.main === true) {
  const code = await main(process.argv.slice(2))
  process.exit(code)
}
