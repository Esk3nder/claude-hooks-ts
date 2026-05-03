import { Effect, Schema, Cause } from "effect"
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
import type { FileSystem } from "./services/filesystem.ts"
import type { Shell } from "./services/shell.ts"
import type { Git } from "./services/git.ts"
import type { Project } from "./services/project.ts"
import type { SessionState } from "./services/session-state.ts"

type AppServices = FileSystem | Shell | Git | Project | SessionState | Approvals

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

const dispatchPayload = (
  action: string,
  payload: HookPayload,
): Effect.Effect<HookDecision, never, AppServices> => {
  switch (payload._tag) {
    case "PreToolUse":
      return handlePreToolUse(payload)
    case "ConfigChange":
      return handleConfigChange(payload)
    case "FileChanged":
      return handleFileChanged(payload)
    case "SessionStart":
      return handleSessionStart(payload)
    case "UserPromptSubmit":
      return handleUserPromptSubmit(payload)
    case "PostToolUse":
      return handlePostToolUse(payload)
    case "PostToolBatch":
      return handlePostToolBatch(payload)
    case "Stop":
      return handleStop(payload)
    case "PreCompact":
      return handlePreCompact(payload)
    case "SessionEnd":
      return handleSessionEnd(payload)
    case "PostToolUseFailure":
      return handlePostToolUseFailure(payload)
    case "PermissionRequest":
      return handlePermissionRequest(payload)
    case "SubagentStart":
      return handleSubagentStart(payload)
    case "SubagentStop":
      return handleSubagentStop(payload)
    case "TaskCreated":
      return handleTaskCreated(payload)
    case "TaskCompleted":
      return handleTaskCompleted(payload)
    default:
      return handleStub(action, payload)
  }
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
    const decision = yield* dispatchPayload(action, payload).pipe(
      Effect.provide(AppLive),
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
