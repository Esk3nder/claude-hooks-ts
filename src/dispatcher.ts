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
import { handleSubagentStart, handleSubagentStop } from "./events/subagent-scope-gate.ts"
import { handleTaskCreated, handleTaskCompleted } from "./events/task-integrity.ts"
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
import { PolicyConfig } from "./services/policy-config.ts"
import { StdinParseError } from "./schema/errors.ts"
import { AppLive } from "./layers/live.ts"
import { TracingLive } from "./services/tracing.ts"
import { withSession } from "./services/session-context.ts"
import type { FileSystem } from "./services/filesystem.ts"
import type { Shell } from "./services/shell.ts"
import type { Git } from "./services/git.ts"
import type { Project } from "./services/project.ts"
import type { SessionState } from "./services/session-state.ts"

type AppServices = FileSystem | Shell | Git | Project | SessionState | Approvals | Elicitations | PolicyConfig

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
        return await (Bun as { stdin: { text: () => Promise<string> } }).stdin.text()
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
const maybeGcApprovals = (
  cwd: string,
): Effect.Effect<void, never, Approvals> =>
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

const dispatchPayload = (
  _action: string,
  payload: HookPayload,
): Effect.Effect<HookDecision, never, AppServices> => {
  const hang = testHangEvent()
  const baseHandler: Effect.Effect<HookDecision, never, AppServices> =
    hang !== null && hang === payload._tag
      ? Effect.sleep("5 seconds").pipe(Effect.as(SAFE_DEFAULT))
      : routeByTag(payload)

  // Per-handler 4s cap → on timeout, fall back to safe default ({}).
  const guarded = baseHandler.pipe(
    Effect.withSpan(`handler.${payload._tag}`),
    Effect.timeout("4 seconds"),
    Effect.catchTag("TimeoutException", () =>
      Effect.succeed(SAFE_DEFAULT),
    ),
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
      yield* Effect.sync(() => { process.stderr.write("dispatcher: missing action argument" + "\n") })
      yield* emit(SAFE_DEFAULT)
      return
    }
    const raw = yield* readStdin()
    if (raw.trim().length === 0) {
      yield* Effect.sync(() => { process.stderr.write("dispatcher: stdin was empty\n") })
      yield* emit(SAFE_DEFAULT)
      return
    }
    const parsedE = yield* Effect.either(parseJson(raw))
    if (parsedE._tag === "Left") {
      yield* Effect.sync(() => { process.stderr.write(`dispatcher: ${parsedE.left.message}` + "\n") })
      yield* emit(SAFE_DEFAULT)
      return
    }
    const decodedE = yield* Effect.either(decodePayload(parsedE.right))
    if (decodedE._tag === "Left") {
      yield* Effect.sync(() => { process.stderr.write("dispatcher: payload schema decode failed" + "\n") })
      yield* emit(SAFE_DEFAULT)
      return
    }
    const payload = decodedE.right
    const layer = Layer.mergeAll(AppLive, TracingLive)
    const decision = yield* withSession(
      payload.session_id,
      dispatchPayload(action, payload).pipe(Effect.provide(layer)),
    )
    yield* emit(decision)
    // Best-effort post-emit gc — never blocks or affects the response.
    const cwd =
      (typeof payload.cwd === "string" && payload.cwd.length > 0
        ? payload.cwd
        : process.cwd())
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
