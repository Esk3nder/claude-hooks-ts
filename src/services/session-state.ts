import { Context, Effect, Layer, Ref } from "effect"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as path from "node:path"
import { FsError } from "../schema/errors.ts"

export type VerificationStatus = "passed" | "failed" | "none"

export interface SessionStateRecord {
  readonly files_read: ReadonlyArray<string>
  readonly files_changed: ReadonlyArray<string>
  readonly commands_run: ReadonlyArray<string>
  readonly commands_failed: ReadonlyArray<string>
  readonly tests_run: ReadonlyArray<string>
  readonly verification_status: VerificationStatus
  readonly next_required_action: string | null
  readonly stop_blocked_once: boolean
  readonly source_urls: ReadonlyArray<string>
  readonly subagent_starts: ReadonlyArray<string>
  readonly subagent_stops: ReadonlyArray<string>
  readonly last_workflow: string | null
}

export const EMPTY_SESSION_STATE: SessionStateRecord = {
  files_read: [],
  files_changed: [],
  commands_run: [],
  commands_failed: [],
  tests_run: [],
  verification_status: "none",
  next_required_action: null,
  stop_blocked_once: false,
  source_urls: [],
  subagent_starts: [],
  subagent_stops: [],
  last_workflow: null,
}

export type AppendableKey =
  | "files_read"
  | "files_changed"
  | "commands_run"
  | "commands_failed"
  | "tests_run"
  | "source_urls"
  | "subagent_starts"
  | "subagent_stops"

export interface SessionStateApi {
  readonly get: (sessionId: string) => Effect.Effect<SessionStateRecord, FsError>
  readonly update: (
    sessionId: string,
    patch: Partial<SessionStateRecord>,
  ) => Effect.Effect<void, FsError>
  readonly append: (
    sessionId: string,
    key: AppendableKey,
    value: string,
  ) => Effect.Effect<void, FsError>
}

export class SessionState extends Context.Tag("SessionState")<
  SessionState,
  SessionStateApi
>() {}

const statePath = (root: string, sessionId: string): string =>
  path.join(root, ".claude-hooks", "state", `${sessionId}.json`)

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const isStringArray = (v: unknown): v is ReadonlyArray<string> =>
  Array.isArray(v) && v.every((x) => typeof x === "string")

const parseRecord = (raw: string): SessionStateRecord => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return EMPTY_SESSION_STATE
    const get = (k: string): unknown => parsed[k]
    const filesRead = get("files_read")
    const filesChanged = get("files_changed")
    const commandsRun = get("commands_run")
    const commandsFailed = get("commands_failed")
    const testsRun = get("tests_run")
    const verification = get("verification_status")
    const next = get("next_required_action")
    const stopBlocked = get("stop_blocked_once")
    const sourceUrls = get("source_urls")
    return {
      files_read: isStringArray(filesRead) ? filesRead : [],
      files_changed: isStringArray(filesChanged) ? filesChanged : [],
      commands_run: isStringArray(commandsRun) ? commandsRun : [],
      commands_failed: isStringArray(commandsFailed) ? commandsFailed : [],
      tests_run: isStringArray(testsRun) ? testsRun : [],
      verification_status:
        verification === "passed" || verification === "failed"
          ? verification
          : "none",
      next_required_action: typeof next === "string" ? next : null,
      stop_blocked_once: stopBlocked === true,
      source_urls: isStringArray(sourceUrls) ? sourceUrls : [],
      subagent_starts: isStringArray(get("subagent_starts")) ? (get("subagent_starts") as ReadonlyArray<string>) : [],
      subagent_stops: isStringArray(get("subagent_stops")) ? (get("subagent_stops") as ReadonlyArray<string>) : [],
      last_workflow: typeof get("last_workflow") === "string" ? (get("last_workflow") as string) : null,
    }
  } catch {
    return EMPTY_SESSION_STATE
  }
}

const mergePatch = (
  prev: SessionStateRecord,
  patch: Partial<SessionStateRecord>,
): SessionStateRecord => ({
  ...prev,
  ...patch,
})

export const SessionStateLive = (
  root: string = process.cwd(),
): Layer.Layer<SessionState> =>
  Layer.succeed(
    SessionState,
    SessionState.of({
      get: (sessionId) =>
        Effect.tryPromise({
          try: async () => {
            const file = statePath(root, sessionId)
            try {
              const raw = await fs.readFile(file, "utf8")
              return parseRecord(raw)
            } catch {
              return EMPTY_SESSION_STATE
            }
          },
          catch: (cause) =>
            new FsError({
              op: "session-state.get",
              path: statePath(root, sessionId),
              message: String(cause),
              cause,
            }),
        }),
      update: (sessionId, patch) =>
        Effect.tryPromise({
          try: async () => {
            const file = statePath(root, sessionId)
            await fs.mkdir(path.dirname(file), { recursive: true })
            let prev: SessionStateRecord = EMPTY_SESSION_STATE
            if (fsSync.existsSync(file)) {
              const raw = await fs.readFile(file, "utf8")
              prev = parseRecord(raw)
            }
            const next = mergePatch(prev, patch)
            await fs.writeFile(file, JSON.stringify(next, null, 2), "utf8")
          },
          catch: (cause) =>
            new FsError({
              op: "session-state.update",
              path: statePath(root, sessionId),
              message: String(cause),
              cause,
            }),
        }),
      append: (sessionId, key, value) =>
        Effect.tryPromise({
          try: async () => {
            const file = statePath(root, sessionId)
            await fs.mkdir(path.dirname(file), { recursive: true })
            let prev: SessionStateRecord = EMPTY_SESSION_STATE
            if (fsSync.existsSync(file)) {
              const raw = await fs.readFile(file, "utf8")
              prev = parseRecord(raw)
            }
            const arr = prev[key]
            const nextArr = arr.includes(value) ? arr : [...arr, value]
            const next: SessionStateRecord = { ...prev, [key]: nextArr }
            await fs.writeFile(file, JSON.stringify(next, null, 2), "utf8")
          },
          catch: (cause) =>
            new FsError({
              op: "session-state.append",
              path: statePath(root, sessionId),
              message: String(cause),
              cause,
            }),
        }),
    }),
  )

export const SessionStateTest = (
  initial: ReadonlyMap<string, SessionStateRecord> = new Map(),
): Layer.Layer<SessionState> =>
  Layer.effect(
    SessionState,
    Effect.gen(function* () {
      const ref = yield* Ref.make<Map<string, SessionStateRecord>>(
        new Map(initial),
      )
      return SessionState.of({
        get: (sessionId) =>
          Ref.get(ref).pipe(
            Effect.map((m) => m.get(sessionId) ?? EMPTY_SESSION_STATE),
          ),
        update: (sessionId, patch) =>
          Ref.update(ref, (m) => {
            const prev = m.get(sessionId) ?? EMPTY_SESSION_STATE
            const next = mergePatch(prev, patch)
            const out = new Map(m)
            out.set(sessionId, next)
            return out
          }),
        append: (sessionId, key, value) =>
          Ref.update(ref, (m) => {
            const prev = m.get(sessionId) ?? EMPTY_SESSION_STATE
            const arr = prev[key]
            const nextArr = arr.includes(value) ? arr : [...arr, value]
            const next: SessionStateRecord = { ...prev, [key]: nextArr }
            const out = new Map(m)
            out.set(sessionId, next)
            return out
          }),
      })
    }),
  )
