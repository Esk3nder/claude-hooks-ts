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
import { Approvals, shouldGc } from "./services/approvals.ts"
import { StdinParseError } from "./schema/errors.ts"
import { AppLive } from "./layers/live.ts"
import { TracingLive } from "./services/tracing.ts"
import { withSession } from "./services/session-context.ts"
import type { FileSystem } from "./services/filesystem.ts"
import type { Shell } from "./services/shell.ts"
import type { Git } from "./services/git.ts"
import type { Project } from "./services/project.ts"
import type { SessionState } from "./services/session-state.ts"

type AppServices = FileSystem | Shell | Git | Project | SessionState | Approvals

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

const emit = (decision: HookDecision): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(JSON.stringify(decision))
  })

const parseJson = (raw: string): Effect.Effect<unknown, StdinParseError> =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) =>
      new StdinParseError({ message: "stdin is not valid JSON", cause }),
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
    yield* approvals.gc(cwd, now).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
  })

/**
 * Total dispatch via Match.tag.exhaustive — TS will fail compile if any
 * HookPayload variant is unhandled.
 */
const routeByTag = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, AppServices> =>
  Match.value(payload).pipe(
    Match.tag("PreToolUse", (p) => handlePreToolUse(p)),
    Match.tag("Stop", (p) => handleStop(p)),
    Match.tag("PostToolBatch", (p) => handlePostToolBatch(p)),
    Match.tag("SessionStart", (p) => handleSessionStart(p)),
    Match.tag("UserPromptSubmit", (p) => handleUserPromptSubmit(p)),
    Match.tag("PostToolUse", (p) => handlePostToolUse(p)),
    Match.tag("PreCompact", (p) => handlePreCompact(p)),
    Match.tag("SessionEnd", (p) => handleSessionEnd(p)),
    Match.tag("PostToolUseFailure", (p) => handlePostToolUseFailure(p)),
    Match.tag("PermissionRequest", (p) => handlePermissionRequest(p)),
    Match.tag("SubagentStart", (p) => handleSubagentStart(p)),
    Match.tag("SubagentStop", (p) => handleSubagentStop(p)),
    Match.tag("TaskCreated", (p) => handleTaskCreated(p)),
    Match.tag("TaskCompleted", (p) => handleTaskCompleted(p)),
    Match.tag("ConfigChange", (p) => handleConfigChange(p)),
    Match.tag("FileChanged", (p) => handleFileChanged(p)),
    Match.tag("UserPromptExpansion", (p) => handleUserPromptExpansion(p)),
    Match.tag("PostCompact", (p) => handlePostCompact(p)),
    Match.exhaustive,
  )

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
