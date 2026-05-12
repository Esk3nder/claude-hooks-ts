import { Effect, Schema, Cause, Match, Layer } from "effect"
import * as fsSync from "node:fs"
import * as path from "node:path"
import { BunRuntime } from "@effect/platform-bun"
import { HookPayload } from "./schema/payloads.ts"
import { SAFE_DEFAULT, type HookDecision } from "./schema/decisions.ts"
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
import type { FileSystem } from "./services/filesystem.ts"
import type { Shell } from "./services/shell.ts"
import type { Git } from "./services/git.ts"
import type { Project } from "./services/project.ts"
import type { SessionState } from "./services/session-state.ts"
import type { ClaudeSubprocess } from "./services/claude-subprocess.ts"
import type { Inference } from "./services/inference.ts"
import type { ClassifierTelemetry } from "./services/classifier-telemetry.ts"
import type { Redact } from "./services/redact.ts"

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

/**
 * Test-only override: replace one event handler with an arbitrary Effect.
 * Used by `test/dispatcher-timeout.test.ts` to inject a slow handler so the
 * Effect.timeout cap can be observed.
 *
 * Activated only when `CLAUDE_HOOKS_TEST_HANG_EVENT` is set; otherwise has no
 * runtime effect.
 */
const testHangEvent = (): string | null => {
  const v = process.env["CLAUDE_HOOKS_TEST_HANG_EVENT"]
  return typeof v === "string" && v.length > 0 ? v : null
}

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

/**
 * Type guard for the WorktreeCreate raw-string output shape. WorktreeCreate
 * uniquely emits `{ worktreePath: string }`, which we serialize as a bare
 * filesystem path on stdout (NOT JSON) so `git worktree add` consumers can
 * read the path directly.
 */
const isWorktreeCreateDecision = (
  d: HookDecision,
): d is { worktreePath: string } =>
  typeof (d as { worktreePath?: unknown }).worktreePath === "string"

const emit = (decision: HookDecision): Effect.Effect<void> =>
  Effect.sync(() => {
    if (isWorktreeCreateDecision(decision)) {
      process.stdout.write(decision.worktreePath)
      return
    }
    process.stdout.write(JSON.stringify(decision))
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
  payload: HookPayload,
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
      Effect.sync(() => {
        process.stderr.write(`dispatcher: ledger append failed: ${String(err)}\n`)
      }),
    ),
    Effect.catchAll(() => Effect.succeed(undefined)),
  )

const parseJson = (raw: string): Effect.Effect<unknown, StdinParseError> =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) =>
      new StdinParseError({
        message: `stdin not valid JSON: ${raw.slice(0, 80)}`,
        cause,
      }),
  })

const decodePayload = Schema.decodeUnknown(HookPayload)

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
const maybeGcApprovals = (cwd: string): Effect.Effect<void, never, Approvals> =>
  Effect.gen(function* () {
    const now = Date.now()
    const last = readLastGc(cwd)
    if (!shouldGc(now, last)) return
    const approvals = yield* Approvals
    yield* approvals.gc(cwd, now).pipe(
      Effect.tapError((err) =>
        Effect.sync(() => {
          process.stderr.write(
            `dispatcher: approvals.gc failed: ${String(err)}\n`,
          )
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
  payload: HookPayload,
): Effect.Effect<HookDecision, never, AppServices> =>
  Match.type<HookPayload>().pipe(
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
const HANDLER_TIMEOUT_MS: Partial<Record<HookPayload["_tag"], number>> = {
  UserPromptSubmit: 30_000,
  // Stop may run one verify-map command (capped at 22s) plus local gate and
  // state I/O. Keep this under Claude's 30s hook envelope; the Stop handler
  // also skips best-effort regenerate work when the remaining budget is tight.
  Stop: 28_000,
}
const DEFAULT_HANDLER_TIMEOUT_MS = 4_000

const handlerTimeoutFor = (tag: HookPayload["_tag"]): number =>
  HANDLER_TIMEOUT_MS[tag] ?? DEFAULT_HANDLER_TIMEOUT_MS

const dispatchPayload = (
  _action: string,
  payload: HookPayload,
): Effect.Effect<HookDecision, never, AppServices> => {
  const hang = testHangEvent()
  const cap = handlerTimeoutFor(payload._tag)
  // Hang test sleeps 1s past the per-tag cap so the timeout always fires.
  const hangSleepMs = cap + 1_000
  const baseHandler: Effect.Effect<HookDecision, never, AppServices> =
    hang !== null && hang === payload._tag
      ? Effect.sleep(`${hangSleepMs} millis`).pipe(Effect.as(SAFE_DEFAULT))
      : routeByTag(payload)

  // Per-handler cap (per-tag) → on timeout, fall back to safe default ({}).
  const guarded = baseHandler.pipe(
    Effect.withSpan(`handler.${payload._tag}`),
    Effect.timeout(`${cap} millis`),
    Effect.catchTag("TimeoutException", () => Effect.succeed(SAFE_DEFAULT)),
  ) as Effect.Effect<HookDecision, never, AppServices>

  return guarded.pipe(
    Effect.withSpan("dispatch", {
      attributes: { event: payload._tag },
    }),
  ) as Effect.Effect<HookDecision, never, AppServices>

  // _stub kept reachable for non-tag-shaped fallback; not used post-Match.
  void handleStub
}

export const program = (argv: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.gen(function* () {
    const action = argv[2]
    if (!action) {
      yield* Effect.sync(() => {
        process.stderr.write("dispatcher: missing action argument" + "\n")
      })
      yield* emit(SAFE_DEFAULT)
      return
    }
    const raw = yield* readStdin()
    if (raw.trim().length === 0) {
      yield* Effect.sync(() => {
        process.stderr.write("dispatcher: stdin was empty\n")
      })
      yield* emit(malformedPayloadFallbackFor(action))
      return
    }
    const parsedE = yield* Effect.either(parseJson(raw))
    if (parsedE._tag === "Left") {
      yield* Effect.sync(() => {
        process.stderr.write(`dispatcher: ${parsedE.left.message}` + "\n")
      })
      yield* emit(malformedPayloadFallbackFor(action))
      return
    }
    const decodedE = yield* Effect.either(decodePayload(parsedE.right))
    if (decodedE._tag === "Left") {
      yield* Effect.sync(() => {
        process.stderr.write("dispatcher: payload schema decode failed" + "\n")
      })
      yield* emit(malformedPayloadFallbackFor(action))
      return
    }
    const payload = decodedE.right
    const cwd =
      typeof payload.cwd === "string" && payload.cwd.length > 0
        ? payload.cwd
        : process.cwd()
    const layer = Layer.mergeAll(makeAppLive(cwd), TracingLive)
    const decision = yield* withSession(
      payload.session_id,
      dispatchPayload(action, payload).pipe(Effect.provide(layer)),
    )
    yield* emit(decision)
    // Persist decision to per-session ledger.jsonl. Best-effort and post-emit
    // so a slow/failing ledger never blocks the hook response.
    yield* appendLedger(payload, decision).pipe(Effect.provide(layer))
    // Best-effort post-emit gc — never blocks or affects the response.
    yield* maybeGcApprovals(cwd).pipe(
      Effect.provide(layer),
      Effect.catchAll(() => Effect.succeed(undefined)),
    )
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          process.stderr.write(
            "dispatcher: uncaught cause: " + Cause.pretty(cause) + "\n",
          )
        })
        yield* emit(SAFE_DEFAULT)
      }),
    ),
  )

if (import.meta.main) {
  BunRuntime.runMain(program(process.argv))
}
