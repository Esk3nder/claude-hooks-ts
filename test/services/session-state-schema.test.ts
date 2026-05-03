import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  SessionState,
  SessionStateLive,
  EMPTY_SESSION_STATE,
} from "../../src/services/session-state.ts"

describe("SessionState schema validation", () => {
  test("corrupted JSON (schema mismatch) → EMPTY + .corrupt-*.bak preserved + stderr warning", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "session-state-"))
    const sid = "sid-bad"
    const stateDir = path.join(tmp, ".claude-hooks", "state")
    await fs.mkdir(stateDir, { recursive: true })
    const file = path.join(stateDir, `${sid}.json`)
    // Valid JSON, but wrong shape — schema must reject.
    const bad = JSON.stringify({ totally: "wrong", shape: 42 })
    await fs.writeFile(file, bad, "utf8")

    // Capture stderr.
    const origWrite = process.stderr.write.bind(process.stderr)
    let captured = ""
    ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (
      s: string,
    ) => {
      captured += s
      return true
    }

    try {
      const r = await Effect.runPromise(
        Effect.gen(function* () {
          const s = yield* SessionState
          return yield* s.get(sid)
        }).pipe(Effect.provide(SessionStateLive(tmp))),
      )
      expect(r).toEqual(EMPTY_SESSION_STATE)
    } finally {
      ;(process.stderr as unknown as { write: typeof origWrite }).write =
        origWrite
    }

    expect(captured).toContain("session-state: schema mismatch")
    expect(captured).toContain(sid)

    // .corrupt-*.bak sibling exists with original bytes.
    const siblings = fsSync
      .readdirSync(stateDir)
      .filter((n) => n.startsWith(`${sid}.json.corrupt-`) && n.endsWith(".bak"))
    expect(siblings.length).toBe(1)
    const bakRaw = await fs.readFile(path.join(stateDir, siblings[0]!), "utf8")
    expect(bakRaw).toBe(bad)

    await fs.rm(tmp, { recursive: true, force: true })
  })

  test("valid JSON shape → returns the record unchanged", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "session-state-"))
    const sid = "sid-good"
    const stateDir = path.join(tmp, ".claude-hooks", "state")
    await fs.mkdir(stateDir, { recursive: true })
    const file = path.join(stateDir, `${sid}.json`)
    const good = {
      ...EMPTY_SESSION_STATE,
      files_changed: ["a.ts"],
      next_required_action: "ship it",
    }
    await fs.writeFile(file, JSON.stringify(good), "utf8")

    const r = await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* SessionState
        return yield* s.get(sid)
      }).pipe(Effect.provide(SessionStateLive(tmp))),
    )
    expect(r.files_changed).toEqual(["a.ts"])
    expect(r.next_required_action).toBe("ship it")

    await fs.rm(tmp, { recursive: true, force: true })
  })
})
