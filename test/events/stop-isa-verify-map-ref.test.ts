/**
 * ISA-resident verify-map reference — the Stop gate honors a per-task
 * `verify_map: <relative-path>` field in the active ISA's frontmatter by
 * loading that file with the same parser as the repo verify-map and
 * concatenating its rules before selection.
 *
 * Design notes:
 *  - No new file format. No merge semantics. The combined list is a flat
 *    array; existing priority/specificity tiebreak in `selectVerifyCommand`
 *    handles conflicts.
 *  - Missing / malformed ISA-referenced file degrades to repo rules only.
 *  - No ISA = no field = today's behavior, untouched.
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

const SID = "isa-vm-ref-1"

const stage = (): { root: string; cleanup: () => void } => {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), "chts-isa-vm-ref-"))
  const root = fs.realpathSync(raw)
  fs.mkdirSync(path.join(root, ".claude-hooks"), { recursive: true })
  // Repo floor: a `["false"]` rule for src/**/*.ts. If the ISA-extra
  // rule is correctly merged with higher priority, it overrides this
  // and the run passes. Without the merge, this rule wins and the
  // run fails — which is exactly what we want to detect.
  fs.writeFileSync(
    path.join(root, ".claude-hooks", "verify-map.yaml"),
    'rules:\n  - source: "src/**/*.ts"\n    command: ["false"]\n    priority: 100\n',
    "utf-8",
  )
  return { root, cleanup: () => fs.rmSync(raw, { recursive: true, force: true }) }
}

const ENGAGED = (root: string) => ({
  engagement_required: true,
  last_mode: "ALGORITHM",
  last_tier: 3,
  engagement_mode: "ALGORITHM",
  engagement_tier: 3,
  expected_isa_path: `.claude-hooks/work/${SID}/ISA.md`,
  expected_isa_path_absolute: path.join(
    root,
    `.claude-hooks/work/${SID}/ISA.md`,
  ),
  session_root: root,
})

// Complete E3-tier ISA body so the completeness gate doesn't fire; tests
// here are scoped to the verify-map merge behavior, not the ISA gate.
const COMPLETE_BODY = `\n\n## Problem\nx\n\n## Vision\nx\n\n## Out of Scope\nx\n\n## Constraints\nx\n\n## Goal\nx\n\n## Criteria\n- [x] ISC-1: x\n\n## Test Strategy\nISC-1 | unit | x | x | x\n\n## Features\nx | ISC-1 | none | yes\n\n## Verification\n- ISC-1: passed\n`

const writeIsa = (root: string, frontmatter: string) => {
  const dir = path.join(root, ".claude-hooks", "work", SID)
  fs.mkdirSync(dir, { recursive: true })
  const fm = `effort: advanced\nphase: complete\nclassifier_mode: ALGORITHM\nclassifier_tier: E3\nclassifier_reason: fixture\n${frontmatter}`
  fs.writeFileSync(
    path.join(dir, "ISA.md"),
    `---\n${fm}\n---${COMPLETE_BODY}`,
    "utf-8",
  )
}

describe("Stop verify-map: ISA `verify_map` reference", () => {
  test("no verify_map field → today's behavior (repo rules only)", async () => {
    const { root, cleanup } = stage()
    try {
      writeIsa(root, "")
      const layer = SessionStateTest(
        new Map([
          [
            SID,
            {
              ...EMPTY_SESSION_STATE,
              files_changed: ["src/a.ts"],
              verification_files: [],
              ...ENGAGED(root),
            },
          ],
        ]),
      )
      const d = await Effect.runPromise(
        handleStop(stop(SID, root)).pipe(Effect.provide(layer)),
      )
      // Repo rule is `["false"]` → exit 1 → block on verification failure.
      const out = d as { decision?: string; reason?: string }
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("Verification failed")
    } finally {
      cleanup()
    }
  })

  test("verify_map points to a valid sibling file → rules merged, lower priority wins", async () => {
    const { root, cleanup } = stage()
    try {
      // Sibling per-task verify-map: lower priority (1) overrides the
      // repo's `false` rule (priority 100). LOWER WINS in this codebase.
      const taskMap = path.join(
        root,
        ".claude-hooks",
        "work",
        SID,
        "verify-map.yaml",
      )
      fs.mkdirSync(path.dirname(taskMap), { recursive: true })
      fs.writeFileSync(
        taskMap,
        'rules:\n  - source: "src/**/*.ts"\n    command: ["true"]\n    priority: 1\n',
        "utf-8",
      )
      writeIsa(
        root,
        `verify_map: .claude-hooks/work/${SID}/verify-map.yaml`,
      )
      const layer = SessionStateTest(
        new Map([
          [
            SID,
            {
              ...EMPTY_SESSION_STATE,
              files_changed: ["src/a.ts"],
              verification_files: [],
              ...ENGAGED(root),
            },
          ],
        ]),
      )
      const program = Effect.gen(function* () {
        const d = yield* handleStop(stop(SID, root))
        const s = yield* SessionState
        const after = yield* s.get(SID)
        return { d, after }
      })
      const { d, after } = await Effect.runPromise(
        program.pipe(Effect.provide(layer)),
      )
      // Merged: ISA rule (`true`, priority 1) beats repo (`false`, 100).
      expect(d).toEqual({})
      expect(after.verification_files).toContain("src/a.ts")
    } finally {
      cleanup()
    }
  })

  test("verify_map points to a missing file → graceful, repo rules apply", async () => {
    const { root, cleanup } = stage()
    try {
      writeIsa(
        root,
        "verify_map: .claude-hooks/missing/nope.yaml",
      )
      const layer = SessionStateTest(
        new Map([
          [
            SID,
            {
              ...EMPTY_SESSION_STATE,
              files_changed: ["src/a.ts"],
              verification_files: [],
              ...ENGAGED(root),
            },
          ],
        ]),
      )
      const d = await Effect.runPromise(
        handleStop(stop(SID, root)).pipe(Effect.provide(layer)),
      )
      const out = d as { decision?: string; reason?: string }
      // Missing file is silently empty; repo `false` rule still applies → block.
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("Verification failed")
    } finally {
      cleanup()
    }
  })

  test("verify_map points to a malformed file → graceful, repo rules apply", async () => {
    const { root, cleanup } = stage()
    try {
      const taskMap = path.join(
        root,
        ".claude-hooks",
        "work",
        SID,
        "verify-map.yaml",
      )
      fs.mkdirSync(path.dirname(taskMap), { recursive: true })
      // Deliberately broken YAML.
      fs.writeFileSync(taskMap, "this is: not [valid yaml\n", "utf-8")
      writeIsa(
        root,
        `verify_map: .claude-hooks/work/${SID}/verify-map.yaml`,
      )
      const layer = SessionStateTest(
        new Map([
          [
            SID,
            {
              ...EMPTY_SESSION_STATE,
              files_changed: ["src/a.ts"],
              verification_files: [],
              ...ENGAGED(root),
            },
          ],
        ]),
      )
      const d = await Effect.runPromise(
        handleStop(stop(SID, root)).pipe(Effect.provide(layer)),
      )
      const out = d as { decision?: string; reason?: string }
      // Malformed file degrades to []; repo `false` rule still applies → block.
      expect(out.decision).toBe("block")
      expect(out.reason ?? "").toContain("Verification failed")
    } finally {
      cleanup()
    }
  })
})
