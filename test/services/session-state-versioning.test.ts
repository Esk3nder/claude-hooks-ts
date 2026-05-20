/**
 * P0-5 — Session-state schema versioning.
 *
 * Three pins:
 *   1. Fresh writes stamp `_schema_version: SESSION_STATE_SCHEMA_VERSION`.
 *   2. Legacy records (no `_schema_version` field) continue to parse via
 *      the existing forward-compat merge — no warning, no reset.
 *   3. Future-version records (`_schema_version: 999`) log a warning AND
 *      return EMPTY_SESSION_STATE — refuse to silently merge with wrong
 *      assumptions OR back up the file (an older install must NOT
 *      destroy a newer install's session data).
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
  EMPTY_SESSION_STATE,
  SESSION_STATE_SCHEMA_VERSION,
  SessionState,
  SessionStateLive,
} from "../../src/services/session-state.ts"

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "session-state-versioning-"))
})

afterEach(async () => {
  try {
    await fs.rm(root, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

const stateFile = (sid: string): string =>
  path.join(root, ".claude-hooks", "state", `${sid}.json`)

describe("session-state schema versioning (P0-5)", () => {
  test("fresh update stamps the current schema version on disk", async () => {
    const sid = "sid-versioning-fresh"
    await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* SessionState
        yield* api.update(sid, { files_read: ["/a.ts"] })
      }).pipe(Effect.provide(SessionStateLive(root))),
    )

    const raw = await fs.readFile(stateFile(sid), "utf8")
    const parsed = JSON.parse(raw) as { _schema_version?: number }
    expect(parsed._schema_version).toBe(SESSION_STATE_SCHEMA_VERSION)
  })

  test("appendBatch stamps the current schema version", async () => {
    const sid = "sid-versioning-append"
    await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* SessionState
        yield* api.appendBatch(sid, [
          { key: "commands_run", value: "bun test" },
        ])
      }).pipe(Effect.provide(SessionStateLive(root))),
    )

    const raw = await fs.readFile(stateFile(sid), "utf8")
    const parsed = JSON.parse(raw) as { _schema_version?: number }
    expect(parsed._schema_version).toBe(SESSION_STATE_SCHEMA_VERSION)
  })

  test("legacy record (no _schema_version) parses normally — back-compat", async () => {
    const sid = "sid-versioning-legacy"
    const file = stateFile(sid)
    await fs.mkdir(path.dirname(file), { recursive: true })
    // Legacy record: looks like the pre-P0-5 on-disk shape (a known key
    // present, no _schema_version). The forward-compat merge must still
    // fill defaults and parse without warning.
    await fs.writeFile(
      file,
      JSON.stringify({ files_read: ["/legacy.ts"] }),
      "utf8",
    )

    const origWarn = console.error
    let warnings = ""
    console.error = (...args: unknown[]) => {
      warnings += args.join(" ")
    }
    try {
      const record = await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* SessionState
          return yield* api.get(sid)
        }).pipe(Effect.provide(SessionStateLive(root))),
      )
      expect(record.files_read).toContain("/legacy.ts")
    } finally {
      console.error = origWarn
    }
    expect(warnings).not.toContain("schema_version")
    expect(warnings).not.toContain("future")
  })

  test("future-version record (_schema_version: 999) warns + returns EMPTY", async () => {
    const sid = "sid-versioning-future"
    const file = stateFile(sid)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const futurePayload = {
      _schema_version: 999,
      files_read: ["/should-not-be-trusted.ts"],
      mystery_new_field: "the future has rules we don't know",
    }
    await fs.writeFile(file, JSON.stringify(futurePayload), "utf8")

    const origWarn = console.error
    let warnings = ""
    console.error = (...args: unknown[]) => {
      warnings += args.join(" ")
    }
    try {
      const record = await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* SessionState
          return yield* api.get(sid)
        }).pipe(Effect.provide(SessionStateLive(root))),
      )
      // Must NOT silently honor the future record's fields.
      expect(record.files_read).not.toContain("/should-not-be-trusted.ts")
      // Safe fallback: EMPTY.
      expect(record.files_read.length).toBe(0)
    } finally {
      console.error = origWarn
    }
    expect(warnings).toContain("schema_version")
    expect(warnings).toContain("999")
  })

  test("future-version record is NOT backed up (refuses to destroy newer install's data)", async () => {
    const sid = "sid-versioning-no-backup"
    const file = stateFile(sid)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({ _schema_version: 999, files_read: ["/keep-me.ts"] }),
      "utf8",
    )

    const origWarn = console.error
    console.error = () => {}
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* SessionState
          return yield* api.get(sid)
        }).pipe(Effect.provide(SessionStateLive(root))),
      )
    } finally {
      console.error = origWarn
    }

    const siblings = (await fs.readdir(path.dirname(file))).filter(
      (n) => n.startsWith(`${sid}.json.corrupt-`) && n.endsWith(".bak"),
    )
    expect(siblings.length).toBe(0)
    // Original file still on disk untouched.
    const raw = await fs.readFile(file, "utf8")
    expect(JSON.parse(raw)).toEqual({
      _schema_version: 999,
      files_read: ["/keep-me.ts"],
    })
  })

  test("EMPTY_SESSION_STATE carries the current schema version", () => {
    expect(EMPTY_SESSION_STATE._schema_version).toBe(
      SESSION_STATE_SCHEMA_VERSION,
    )
  })
})
