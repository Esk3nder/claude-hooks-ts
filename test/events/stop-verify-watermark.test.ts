/**
 * Verify-watermark — the Stop "files-changed-without-verification" gate must
 * key on the set difference `files_changed \ verification_files`, not on
 * `verification_status` alone.
 *
 * Before the fix: `files_changed` grew monotonically across the session;
 * on every Stop the gate re-ran verification because `verification_status`
 * was flipped back to `"none"` by any subsequent edit. The accumulated
 * list re-armed the gate indefinitely.
 *
 * After the fix: a passing verify snapshots `files_changed` into
 * `verification_files`. Subsequent Stops with no new edits see
 * `files_changed ⊆ verification_files` and skip the verify entirely. A
 * re-edit evicts the file from the watermark so the next Stop re-verifies
 * just that file.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { handleStop } from "../../src/events/stop-definition-of-done.ts"
import {
  SessionStateTest,
  EMPTY_SESSION_STATE,
  SessionState,
} from "../../src/services/session-state.ts"

const stop = (sid: string, cwd: string) => ({
  _tag: "Stop" as const,
  session_id: sid,
  hook_event_name: "Stop" as const,
  cwd,
})

const stage = (): { root: string; cleanup: () => void } => {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), "chts-watermark-"))
  const root = fs.realpathSync(raw)
  fs.mkdirSync(path.join(root, ".claude-hooks"), { recursive: true })
  fs.writeFileSync(
    path.join(root, ".claude-hooks", "verify-map.yaml"),
    'rules:\n  - source: "src/**/*.ts"\n    command: ["true"]\n    priority: 100\n',
    "utf-8",
  )
  return { root, cleanup: () => fs.rmSync(raw, { recursive: true, force: true }) }
}

describe("Stop verify-watermark", () => {
  test("files_changed ⊆ verification_files → verify skipped, no block", async () => {
    const { root, cleanup } = stage()
    try {
      const layer = SessionStateTest(
        new Map([
          [
            "sid-1",
            {
              ...EMPTY_SESSION_STATE,
              files_changed: ["src/a.ts", "src/b.ts"],
              verification_files: ["src/a.ts", "src/b.ts"],
              verification_status: "passed" as const,
              session_root: root,
            },
          ],
        ]),
      )
      const d = await Effect.runPromise(
        handleStop(stop("sid-1", root)).pipe(Effect.provide(layer)),
      )
      expect(d).toEqual({})
    } finally {
      cleanup()
    }
  })

  test("new file in files_changed → verifier runs and watermark expands", async () => {
    const { root, cleanup } = stage()
    try {
      const layer = SessionStateTest(
        new Map([
          [
            "sid-2",
            {
              ...EMPTY_SESSION_STATE,
              files_changed: ["src/a.ts", "src/new.ts"],
              verification_files: ["src/a.ts"],
              verification_status: "passed" as const,
              session_root: root,
            },
          ],
        ]),
      )
      const program = Effect.gen(function* () {
        const d = yield* handleStop(stop("sid-2", root))
        const s = yield* SessionState
        const after = yield* s.get("sid-2")
        return { d, after }
      })
      const { d, after } = await Effect.runPromise(
        program.pipe(Effect.provide(layer)),
      )
      expect(d).toEqual({})
      expect(after.verification_files).toContain("src/a.ts")
      expect(after.verification_files).toContain("src/new.ts")
    } finally {
      cleanup()
    }
  })

  test("verification_status none but watermark covers files_changed → no rerun, no block", async () => {
    const { root, cleanup } = stage()
    try {
      // The model edited a file then later flipped verification_status back
      // to "none" (post-edit-quality does this for every real edit). The
      // file is still in the watermark, so the gate must NOT re-run verify.
      const layer = SessionStateTest(
        new Map([
          [
            "sid-3",
            {
              ...EMPTY_SESSION_STATE,
              files_changed: ["src/a.ts"],
              verification_files: ["src/a.ts"],
              verification_status: "none" as const,
              session_root: root,
            },
          ],
        ]),
      )
      const d = await Effect.runPromise(
        handleStop(stop("sid-3", root)).pipe(Effect.provide(layer)),
      )
      expect(d).toEqual({})
    } finally {
      cleanup()
    }
  })

  test("fresh session: file in files_changed, empty watermark → block", async () => {
    const { root, cleanup } = stage()
    try {
      // Note: with no verify-map rules at root we'd hit a different block
      // (no-rule). Stage's writeVerifyMap supplies a `["true"]` rule for
      // src/**/*.ts, so verify would PASS once run. Therefore this case
      // verifies "no cache hit" by checking the watermark grows after the
      // run.
      const layer = SessionStateTest(
        new Map([
          [
            "sid-4",
            {
              ...EMPTY_SESSION_STATE,
              files_changed: ["src/a.ts"],
              verification_files: [],
              verification_status: "none" as const,
              session_root: root,
            },
          ],
        ]),
      )
      const program = Effect.gen(function* () {
        const d = yield* handleStop(stop("sid-4", root))
        const s = yield* SessionState
        const after = yield* s.get("sid-4")
        return { d, after }
      })
      const { d, after } = await Effect.runPromise(
        program.pipe(Effect.provide(layer)),
      )
      expect(d).toEqual({})
      expect(after.verification_files).toContain("src/a.ts")
    } finally {
      cleanup()
    }
  })
})
