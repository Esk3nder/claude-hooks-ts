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

  test("legacy JSON missing `requires_web_sources` → field defaults to false (deny-by-default for the Stop gate)", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "session-state-"))
    const sid = "sid-legacy"
    const stateDir = path.join(tmp, ".claude-hooks", "state")
    await fs.mkdir(stateDir, { recursive: true })
    const file = path.join(stateDir, `${sid}.json`)
    // Construct a pre-PR record: all known fields EXCEPT requires_web_sources.
    // This is what an on-disk JSON file from a prior version looks like.
    // The forward-compat default merge in parseRecordStrict must fill in
    // the missing field with `false` before strict decode, NOT trigger the
    // schema-mismatch backup-and-reset path.
    const legacy = {
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
      last_workflow: "research.web",
      last_mode: null,
      last_tier: null,
      engagement_required: false,
      expected_isa_path: null,
      session_root: null,
      expected_isa_path_absolute: null,
      isa_engaged_at: null,
      // requires_web_sources intentionally omitted
    }
    await fs.writeFile(file, JSON.stringify(legacy), "utf8")

    const r = await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* SessionState
        return yield* s.get(sid)
      }).pipe(Effect.provide(SessionStateLive(tmp))),
    )
    // Field present, defaulted to false — Stop research-gate stays closed
    // on legacy state. Critical invariant: a pre-PR session with
    // `last_workflow: "research.web"` must NOT block Stop after upgrade.
    expect(r.requires_web_sources).toBe(false)
    // Other fields preserved.
    expect(r.last_workflow).toBe("research.web")

    // No corrupt-backup sibling was created (the schema-reset path did NOT fire).
    const siblings = fsSync
      .readdirSync(stateDir)
      .filter((n) => n.startsWith(`${sid}.json.corrupt-`) && n.endsWith(".bak"))
    expect(siblings.length).toBe(0)

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
