import { Effect, Schema, Cause, Match, Layer } from "effect"
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
import type { Approvals } from "./services/approvals.ts"
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
 * Stub for events that have no dedicated handler yet (UserPromptExpansion,
 * PostCompact). Returns SAFE_DEFAULT so dispatch is total over all 18 tags.
 */
const handleNoop = (
  _payload: HookPayload,
): Effect.Effect<HookDecision, never, AppServices> =>
  Effect.succeed(SAFE_DEFAULT)

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
    Match.tag("UserPromptExpansion", (p) => handleNoop(p)),
    Match.tag("PostCompact", (p) => handleNoop(p)),
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
    const decision = yield* withSession(
      payload.session_id,
      dispatchPayload(action, payload).pipe(
        Effect.provide(Layer.mergeAll(AppLive, TracingLive)),
      ),
    )
    yield* emit(decision)
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
