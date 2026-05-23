import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  EMPTY_SESSION_STATE,
  SessionState,
  SessionStateLive,
  type SessionStateRecord,
} from "../../src/services/session-state.ts"

const stateFile = (root: string, sessionId: string): string =>
  path.join(root, ".claude-hooks", "state", `${sessionId}.json`)

const writeState = (
  root: string,
  sessionId: string,
  patch: Partial<SessionStateRecord>,
): void => {
  const file = stateFile(root, sessionId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({ ...EMPTY_SESSION_STATE, ...patch }, null, 2),
    "utf8",
  )
}

const readState = (root: string, sessionId: string): SessionStateRecord =>
  JSON.parse(fs.readFileSync(stateFile(root, sessionId), "utf8")) as SessionStateRecord

describe("SessionStateLive session_root pathing", () => {
  let tmp: string
  let repo: string
  let drift: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ch-state-root-"))
    repo = path.join(tmp, "repo")
    drift = path.join(tmp, "drift")
    fs.mkdirSync(repo, { recursive: true })
    fs.mkdirSync(drift, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test("get follows session_root from a cwd-keyed record", async () => {
    const sessionId = "sid"
    writeState(drift, sessionId, {
      session_root: repo,
      files_changed: [path.join(drift, "wrong.ts")],
    })
    writeState(repo, sessionId, {
      session_root: repo,
      files_changed: [path.join(repo, "right.ts")],
    })

    const record = await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* SessionState
        return yield* state.get(sessionId)
      }).pipe(Effect.provide(SessionStateLive(drift))),
    )

    expect(record.files_changed).toEqual([path.join(repo, "right.ts")])
  })

  test("update writes through to session_root instead of drift cwd", async () => {
    const sessionId = "sid"
    writeState(drift, sessionId, {
      session_root: repo,
      files_changed: [path.join(drift, "wrong.ts")],
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* SessionState
        yield* state.update(sessionId, {
          files_changed: [path.join(repo, "right.ts")],
          verification_status: "passed",
        })
      }).pipe(Effect.provide(SessionStateLive(drift))),
    )

    expect(fs.existsSync(stateFile(repo, sessionId))).toBe(true)
    expect(readState(repo, sessionId).files_changed).toEqual([
      path.join(repo, "right.ts"),
    ])
    expect(readState(repo, sessionId).verification_status).toBe("passed")
    expect(readState(drift, sessionId).files_changed).toEqual([
      path.join(drift, "wrong.ts"),
    ])
  })

  test("initial update with session_root creates the canonical root file", async () => {
    const sessionId = "sid-initial"

    await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* SessionState
        yield* state.update(sessionId, {
          session_root: repo,
          files_changed: [path.join(repo, "created.ts")],
        })
      }).pipe(Effect.provide(SessionStateLive(drift))),
    )

    expect(fs.existsSync(stateFile(repo, sessionId))).toBe(true)
    expect(fs.existsSync(stateFile(drift, sessionId))).toBe(false)
    expect(readState(repo, sessionId).session_root).toBe(repo)
    expect(readState(repo, sessionId).files_changed).toEqual([
      path.join(repo, "created.ts"),
    ])
  })
})
