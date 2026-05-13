import { Effect, Schema, Cause, Match, Layer, Option, Logger } from "effect"
import * as fsSync from "node:fs"
import * as path from "node:path"
import { NO_DECISION, SAFE_DEFAULT, type HookDecision } from "./schema/decisions.ts"
import {
  RawHookPayload,
  NormalizedHookEvent,
  type NormalizedHookEvent as NormalizedHookEventType,
} from "./schema/normalized.ts"
import {
  encodeHookDecision,
  type NormalizedHookDecision,
} from "./schema/normalized-decisions.ts"
import { handleStub } from "./events/_stub.ts"
import { handlePreToolUse } from "./events/pretool-policy.ts"
import { handleConfigChange } from "./events/config-guard.ts"
import { handleFileChanged } from "./events/filechanged-env-guard.ts"
import { handleSessionStart } from "./events/session-start-brief.ts"
import { handleUserPromptSubmit } from "./events/prompt-router.ts"
import { handlePostToolUse } from "./events/post-edit-quality.ts"
import { handlePostToolBatch } from "./events/batch-context-governor.ts"
import { handleStop } from "./events/stop-definition-of-done.ts"
import { handlePreCompact } from "./events/precompact-snapshot.ts"
import { handleSessionEnd } from "./events/session-ledger.ts"
import { handlePostToolUseFailure } from "./events/failure-explainer.ts"
import { handlePermissionRequest } from "./events/permission-autopilot.ts"
import {
  handleSubagentStart,
  handleSubagentStop,
} from "./events/subagent-scope-gate.ts"
import {
  handleTaskCreated,
  handleTaskCompleted,
} from "./events/task-integrity.ts"
import { handleUserPromptExpansion } from "./events/user-prompt-expansion.ts"
import { handlePostCompact } from "./events/postcompact-ledger.ts"
import { handleSetup } from "./events/setup.ts"
import { handlePermissionDenied } from "./events/permission-denied.ts"
import { handleStopFailure } from "./events/stop-failure.ts"
import { handleTeammateIdle } from "./events/teammate-idle.ts"
import { handleNotification } from "./events/notification.ts"
import { handleInstructionsLoaded } from "./events/instructions-loaded.ts"
import { handleCwdChanged } from "./events/cwd-changed.ts"
import { handleWorktreeCreate } from "./events/worktree-create.ts"
import { handleWorktreeRemove } from "./events/worktree-remove.ts"
import { handleElicitation } from "./events/elicitation.ts"
import { handleElicitationResult } from "./events/elicitation-result.ts"
import { Approvals, shouldGc } from "./services/approvals.ts"
import { Elicitations } from "./services/elicitations.ts"
import { Ledger } from "./services/ledger.ts"
import { PolicyConfig } from "./services/policy-config.ts"
import { StdinParseError } from "./schema/errors.ts"
import { makeAppLive } from "./layers/live.ts"
import { TracingLive } from "./services/tracing.ts"
import { withSession } from "./services/session-context.ts"
import {
  RuntimeConfigService,
  durationMillis,
  type RuntimeConfig,
} from "./services/runtime-config.ts"
import { HookFailure, reportHookFailure } from "./services/hook-failure.ts"
import type { FileSystem } from "./services/filesystem.ts"
import type { Shell } from "./services/shell.ts"
import type { Git } from "./services/git.ts"
import type { Project } from "./services/project.ts"
import type { SessionState } from "./services/session-state.ts"
import type { ClaudeSubprocess } from "./services/claude-subprocess.ts"
import type { Inference } from "./services/inference.ts"
import type { ClassifierTelemetry } from "./services/classifier-telemetry.ts"
import type { Redact } from "./services/redact.ts"
import type { EventStore } from "./services/event-store.ts"
import type { CommandRunner } from "./services/command-runner.ts"
import { currentProcessEnv } from "./bootstrap/env.ts"

type AppServices =
  | FileSystem
  | Shell
  | Git
  | Project
  | SessionState
  | Approvals
  | Elicitations
  | Ledger
  | PolicyConfig
  | ClaudeSubprocess
  | Inference
  | ClassifierTelemetry
  | Redact
  | EventStore
  | CommandRunner
  | RuntimeConfigService
  | HookFailure

const readStdin = (): Effect.Effect<string> =>
  Effect.tryPromise({
    try: async () => {
      if (typeof Bun !== "undefined" && (Bun as { stdin?: unknown }).stdin) {
        return await (
          Bun as { stdin: { text: () => Promise<string> } }
        ).stdin.text()
      }
      const chunks: Buffer[] = []
      return await new Promise<string>((resolve) => {
        process.stdin.on("data", (c: Buffer) => chunks.push(c))
        process.stdin.on("end", () =>
          resolve(Buffer.concat(chunks).toString("utf8")),
        )
        process.stdin.on("error", () =>
          resolve(Buffer.concat(chunks).toString("utf8")),
        )
      })
    },
    catch: () => new Error("stdin read failed"),
  }).pipe(Effect.catchAll(() => Effect.succeed("")))

const failureContextFor = (
  payload?: Partial<NormalizedHookEventType> | null,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  ...extra,
  ...(typeof payload?.cwd === "string" ? { cwd: payload.cwd } : {}),
  ...(typeof (payload as { tool_name?: unknown } | undefined)?.tool_name === "string"
    ? { tool_name: (payload as { tool_name: string }).tool_name }
    : {}),
})

const stateRootForHook = (cwd: string): string => {
  const override = currentProcessEnv()["CLAUDE_HOOKS_STATE_ROOT"]
  return typeof override === "string" && override.trim().length > 0
    ? path.resolve(override)
    : cwd
}

const reportFallback = (input: {
  readonly kind: Parameters<typeof reportHookFailure>[0]["kind"]
  readonly event?: string | null | undefined
  readonly sessionId?: string | null | undefined
  readonly cause: unknown
  readonly fallbackDecision?: HookDecision | undefined
  readonly context?: Readonly<Record<string, unknown>> | undefined
  readonly ledger?: boolean | undefined
}): Effect.Effect<void> =>
  reportHookFailure({
    kind: input.kind,
    event: input.event,
    sessionId: input.sessionId,
    cause: input.cause,
    fallbackDecision: input.fallbackDecision,
    hookSafe: true,
    context: input.context,
    ledger: input.ledger,
  })

/**
 * Type guard for the WorktreeCreate raw-string output shape. WorktreeCreate
 * uniquely emits `{ worktreePath: string }`, which we serialize as a bare
 * filesystem path on stdout (NOT JSON) so `git worktree add` consumers can
 * read the path directly.
 */
const isWorktreeCreateDecision = (
  d: NormalizedHookDecision,
): d is { worktreePath: string } =>
  typeof (d as { worktreePath?: unknown }).worktreePath === "string"

export interface EncodedStdoutDecision {
  readonly stdout: string
  readonly encodeFailed: boolean
  readonly cause?: unknown
}

export const encodeDecisionForStdout = (
  decision: NormalizedHookDecision,
  fallback: HookDecision = SAFE_DEFAULT,
): EncodedStdoutDecision => {
  const encoded = encodeHookDecision(decision)
  if (encoded._tag === "Left") {
    const encodedFallback = encodeHookDecision(fallback)
    return {
      encodeFailed: true,
      cause: encoded.left,
      stdout: JSON.stringify(
        encodedFallback._tag === "Right"
          ? encodedFallback.right
          : SAFE_DEFAULT,
      ),
    }
  }
  if (isWorktreeCreateDecision(encoded.right)) {
    return { stdout: encoded.right.worktreePath, encodeFailed: false }
  }
  return { stdout: JSON.stringify(encoded.right), encodeFailed: false }
}

const emit = (
  decision: NormalizedHookDecision,
  fallback: HookDecision = SAFE_DEFAULT,
  meta: {
    readonly event?: string | null
    readonly sessionId?: string | null
    readonly context?: Readonly<Record<string, unknown>>
  } = {},
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const rendered = encodeDecisionForStdout(decision, fallback)
    if (rendered.encodeFailed) {
      yield* reportFallback({
        kind: "decision_encode_failed",
        event: meta.event,
        sessionId: meta.sessionId,
        cause: rendered.cause ?? "decision encode failed",
        fallbackDecision: fallback,
        context: meta.context,
        ledger: true,
      })
    }
    yield* Effect.sync(() => {
      process.stdout.write(rendered.stdout)
    })
  })

const MALFORMED_PRETOOL_USE_FALLBACK: HookDecision = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason:
      "Malformed PreToolUse payload could not be decoded; asking for confirmation instead of allowing tool execution.",
  },
}

/**
 * If the outer dispatcher cannot decode a payload, it normally cannot know
 * enough to run event-specific policy. PreToolUse is the exception: the CLI
 * action itself tells us this was a tool gate, and falling through with `{}`
 * would silently allow the tool. Ask instead.
 */
const malformedPayloadFallbackFor = (action: string): HookDecision =>
  action === "PreToolUse" ? MALFORMED_PRETOOL_USE_FALLBACK : SAFE_DEFAULT

/**
 * Append the dispatched decision to the per-session ledger. Best-effort: any
 * I/O failure is swallowed so the hook response (already on stdout via emit)
 * is never delayed or compromised by ledger problems.
 */
const appendLedger = (
  payload: NormalizedHookEventType,
  decision: HookDecision,
): Effect.Effect<void, never, Ledger> =>
  Effect.flatMap(Ledger, (l) =>
    l.append({
      timestamp: Date.now(),
      event: payload._tag,
      sessionId: payload.session_id,
      data: decision,
    }),
  ).pipe(
    Effect.tapError((err) =>
      reportFallback({
        kind: "ledger_append_failed",
        event: payload._tag,
        sessionId: payload.session_id,
        cause: err,
        fallbackDecision: decision,
        context: failureContextFor(payload),
      }),
    ),
    Effect.catchAll(() => Effect.succeed(undefined)),
  )

const parseJson = (raw: string): Effect.Effect<unknown, StdinParseError> =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) =>
      new StdinParseError({
        message: "stdin not valid JSON",
        cause,
      }),
  })

const decodeRawPayload = Schema.decodeUnknown(RawHookPayload)
const decodeNormalizedEvent = Schema.decode(NormalizedHookEvent)

/**
 * Read approvals meta `last_gc` timestamp synchronously. Returns 0 on miss
 * so first-ever invocation always triggers gc.
 */
const readLastGc = (cwd: string): number => {
  const file = path.join(cwd, ".claude-hooks", "state", "approvals-meta.json")
  try {
    const raw = fsSync.readFileSync(file, "utf8")
    const v = JSON.parse(raw) as { last_gc?: unknown }
    return typeof v.last_gc === "number" ? v.last_gc : 0
  } catch {
    return 0
  }
}

/**
 * Best-effort approvals gc. Runs AFTER the decision is emitted to stdout so
 * it never delays the hook response. Any failure is swallowed.
 */
const maybeGcApprovals = (cwd: string): Effect.Effect<void, never, Approvals | RuntimeConfigService> =>
  Effect.gen(function* () {
    const now = Date.now()
    const last = readLastGc(cwd)
    const configService = yield* RuntimeConfigService
    const config = yield* configService.load()
    if (!shouldGc(now, last, durationMillis(config.approvalGcInterval))) return
    const approvals = yield* Approvals
    yield* approvals.gc(cwd, now).pipe(
      Effect.tapError((err) =>
        reportFallback({
          kind: "state_write_failed",
          event: "ApprovalsGc",
          cause: err,
          fallbackDecision: SAFE_DEFAULT,
          context: { cwd, op: "approvals.gc" },
        }),
      ),
      Effect.catchAll(() => Effect.succeed(undefined)),
    )
  })

/**
 * Total dispatch via Match.tag.exhaustive — TS will fail compile if any
 * HookPayload variant is unhandled.
 */
const routeByTag = (
  payload: NormalizedHookEventType,
): Effect.Effect<HookDecision, never, AppServices> =>
  Match.type<NormalizedHookEventType>().pipe(
    Match.tagsExhaustive({
      PreToolUse: (p) => handlePreToolUse(p),
      Stop: (p) => handleStop(p),
      PostToolBatch: (p) => handlePostToolBatch(p),
      SessionStart: (p) => handleSessionStart(p),
      UserPromptSubmit: (p) => handleUserPromptSubmit(p),
      PostToolUse: (p) => handlePostToolUse(p),
      PreCompact: (p) => handlePreCompact(p),
      SessionEnd: (p) => handleSessionEnd(p),
      PostToolUseFailure: (p) => handlePostToolUseFailure(p),
      PermissionRequest: (p) => handlePermissionRequest(p),
      SubagentStart: (p) => handleSubagentStart(p),
      SubagentStop: (p) => handleSubagentStop(p),
      TaskCreated: (p) => handleTaskCreated(p),
      TaskCompleted: (p) => handleTaskCompleted(p),
      ConfigChange: (p) => handleConfigChange(p),
      FileChanged: (p) => handleFileChanged(p),
      UserPromptExpansion: (p) => handleUserPromptExpansion(p),
      PostCompact: (p) => handlePostCompact(p),
      Setup: (p) => handleSetup(p),
      PermissionDenied: (p) => handlePermissionDenied(p),
      StopFailure: (p) => handleStopFailure(p),
      TeammateIdle: (p) => handleTeammateIdle(p),
      Notification: (p) => handleNotification(p),
      InstructionsLoaded: (p) => handleInstructionsLoaded(p),
      CwdChanged: (p) => handleCwdChanged(p),
      WorktreeCreate: (p) => handleWorktreeCreate(p),
      WorktreeRemove: (p) => handleWorktreeRemove(p),
      Elicitation: (p) => handleElicitation(p),
      ElicitationResult: (p) => handleElicitationResult(p),
    }),
  )(payload)

/**
 * Per-tag handler timeout in milliseconds. Most events stay on the historical
 * 4s cap because their handlers are local file I/O and finish in <100ms. The
 * UserPromptSubmit cap is raised to accommodate the mode-classifier subprocess
 * (Sonnet via `claude --print`, p95 ~7s, p99 ~12s) PLUS this package's 25s inference
 * timeout (PromptProcessing.hook.ts:939). The 30s envelope = 25s classifier
 * timeout + 5s overhead headroom (transcript read, JSONL telemetry, etc.).
 *
 * To raise a tag's cap: add an entry here and a redteam test that proves the
 * old cap would have fired. Don't raise globally — a slow handler on any
 * other tag is a bug, not a budget request.
 */
export const handlerTimeoutFor = (
  tag: NormalizedHookEventType["_tag"],
  config: RuntimeConfig,
): number => {
  switch (tag) {
    case "UserPromptSubmit":
      return durationMillis(config.userPromptSubmitTimeoutMs)
    case "Stop":
      return durationMillis(config.stopTimeoutMs)
    default:
      return durationMillis(config.defaultHandlerTimeoutMs)
  }
}

const dispatchPayload = (
  _action: string,
  payload: NormalizedHookEventType,
): Effect.Effect<HookDecision, never, AppServices> =>
  Effect.gen(function* () {
    const configService = yield* RuntimeConfigService
    const config = yield* configService.load()
    const hang = Option.getOrNull(config.testHangEvent)
    const cap = handlerTimeoutFor(payload._tag, config)
    // Hang test sleeps 1s past the per-tag cap so the timeout always fires.
    const hangSleepMs = cap + 1_000
    const baseHandler: Effect.Effect<HookDecision, never, AppServices> =
      hang !== null && hang === payload._tag
        ? Effect.sleep(`${hangSleepMs} millis`).pipe(Effect.as(NO_DECISION))
        : routeByTag(payload)

    // Per-handler cap (per-tag) → on timeout, fall back to safe default ({}).
    const guarded = baseHandler.pipe(
      Effect.catchAllCause((cause) =>
        reportFallback({
          kind: "handler_failed",
          event: payload._tag,
          sessionId: payload.session_id,
          cause: Cause.pretty(cause),
          fallbackDecision: SAFE_DEFAULT,
          context: failureContextFor(payload),
          ledger: true,
        }).pipe(Effect.as(SAFE_DEFAULT)),
      ),
      Effect.withSpan(`handler.${payload._tag}`),
      Effect.timeout(`${cap} millis`),
      Effect.catchTag("TimeoutException", (err) =>
        reportFallback({
          kind: "handler_timeout",
          event: payload._tag,
          sessionId: payload.session_id,
          cause: err,
          fallbackDecision: SAFE_DEFAULT,
          context: failureContextFor(payload, { cap_ms: cap }),
          ledger: true,
        }).pipe(Effect.as(SAFE_DEFAULT)),
      ),
    ) as Effect.Effect<HookDecision, never, AppServices>

    return yield* guarded.pipe(
      Effect.withSpan("dispatch", {
        attributes: { event: payload._tag },
      }),
    ) as Effect.Effect<HookDecision, never, AppServices>

    // _stub kept reachable for non-tag-shaped fallback; not used post-Match.
    void handleStub
  })


export const program = (argv: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.gen(function* () {
    const action = argv[2]
    if (!action) {
      const fallback = SAFE_DEFAULT
      yield* reportFallback({
        kind: "handler_failed",
        event: "unknown",
        cause: "missing action argument",
        fallbackDecision: fallback,
      })
      yield* emit(fallback, fallback, { event: "unknown" })
      return
    }
    const raw = yield* readStdin()
    if (raw.trim().length === 0) {
      const fallback = malformedPayloadFallbackFor(action)
      yield* reportFallback({
        kind: "stdin_empty",
        event: action,
        cause: "stdin was empty",
        fallbackDecision: fallback,
      })
      yield* emit(fallback, fallback, { event: action })
      return
    }
    const parsedE = yield* Effect.either(parseJson(raw))
    if (parsedE._tag === "Left") {
      const fallback = malformedPayloadFallbackFor(action)
      yield* reportFallback({
        kind: "json_parse_failed",
        event: action,
        cause: parsedE.left,
        fallbackDecision: fallback,
        context: { raw_bytes: Buffer.byteLength(raw, "utf8") },
      })
      yield* emit(fallback, fallback, { event: action })
      return
    }
    const decodedE = yield* Effect.either(decodeRawPayload(parsedE.right))
    if (decodedE._tag === "Left") {
      const fallback = malformedPayloadFallbackFor(action)
      yield* reportFallback({
        kind: "payload_decode_failed",
        event: action,
        cause: "raw payload schema mismatch",
        fallbackDecision: fallback,
        context: { stage: "raw_payload" },
      })
      yield* emit(fallback, fallback, { event: action })
      return
    }
    const normalizedE = yield* Effect.either(decodeNormalizedEvent(decodedE.right))
    if (normalizedE._tag === "Left") {
      const fallback = malformedPayloadFallbackFor(action)
      yield* reportFallback({
        kind: "payload_decode_failed",
        event: action,
        cause: "normalized payload schema mismatch",
        fallbackDecision: fallback,
        context: { stage: "normalized_payload" },
      })
      yield* emit(fallback, fallback, { event: action })
      return
    }
    const payload = normalizedE.right
    const cwd =
      typeof payload.cwd === "string" && payload.cwd.length > 0
        ? payload.cwd
        : process.cwd()
    const stateRoot = stateRootForHook(cwd)
    const layer = Layer.mergeAll(makeAppLive(stateRoot), TracingLive)
    const decision = yield* withSession(
      payload.session_id,
      dispatchPayload(action, payload).pipe(Effect.provide(layer)),
    )
    yield* emit(decision, malformedPayloadFallbackFor(payload._tag), {
      event: payload._tag,
      sessionId: payload.session_id,
      context: failureContextFor(payload),
    }).pipe(Effect.provide(layer))
    // Persist decision to per-session ledger.jsonl. Best-effort and post-emit
    // so a slow/failing ledger never blocks the hook response.
    yield* appendLedger(payload, decision).pipe(Effect.provide(layer))
    // Best-effort post-emit gc — never blocks or affects the response.
    yield* maybeGcApprovals(stateRoot).pipe(
      Effect.provide(layer),
      Effect.catchAll(() => Effect.succeed(undefined)),
    )
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.gen(function* () {
        yield* reportFallback({
          kind: "handler_failed",
          event: "unknown",
          cause: Cause.pretty(cause),
          fallbackDecision: SAFE_DEFAULT,
        })
        yield* emit(SAFE_DEFAULT, SAFE_DEFAULT, { event: "unknown" })
      }),
    ),
  )

const HookLoggerLive = Layer.mergeAll(
  Logger.remove(Logger.defaultLogger),
  Logger.add(Logger.withConsoleError(Logger.logfmtLogger)),
)

if (import.meta.main) {
  await Effect.runPromise(program(process.argv).pipe(Effect.provide(HookLoggerLive)))
}
