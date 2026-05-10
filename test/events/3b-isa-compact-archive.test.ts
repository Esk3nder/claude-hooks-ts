/**
 * Slice 3b — ISA preservation across compaction + archive on session end.
 *
 * Asserts:
 *   - PreCompact snapshot includes `## Active ISAs` section + ISA inline note
 *     in the additionalContext line (project ISA AND latest task ISA).
 *   - PostCompact reads the latest snapshot for the session and emits the
 *     ISA section as additionalContext.
 *   - SessionEnd archives ISAs whose `phase: complete` to
 *     `.claude-hooks/archive/<YYYY-MM-DD>/<slug>/ISA.md` (tracked, NOT under
 *     `.claude-hooks/state/` so it survives in source-controlled history).
 */
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handlePreCompact } from "../../src/events/precompact-snapshot.ts"
import { handlePostCompact } from "../../src/events/postcompact-ledger.ts"
import { handleSessionEnd } from "../../src/events/session-ledger.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { FileSystemLive } from "../../src/services/filesystem.ts"
import { SessionStateLive } from "../../src/services/session-state.ts"
import { Project, type ProjectApi } from "../../src/services/project.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const stage = (): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "chts-3b-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** Project layer pinned to a specific root for isolation. */
const projectAt = (root: string) =>
  Layer.succeed(
    Project,
    Project.of({
      root: () => Effect.succeed(root),
      detectKind: () => Effect.succeed("repo"),
    } as unknown as ProjectApi),
  )

const writeProjectIsa = (root: string, content: string): void => {
  writeFileSync(join(root, "ISA.md"), content, "utf-8")
}

const writeTaskIsa = (root: string, slug: string, content: string): string => {
  const dir = join(root, ".claude-hooks", "work", slug)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, "ISA.md")
  writeFileSync(file, content, "utf-8")
  return file
}

const ISA_BUILD = `---
task: ship the auth refactor
slug: 20260509_auth
phase: build
progress: 1/3
mode: interactive
---

## Goal
Ship the OAuth refresh path without breaking external API consumers.
`

const ISA_COMPLETE = `---
task: shipped
slug: 20260509_done
phase: complete
progress: 3/3
mode: interactive
---

## Goal
Done deal.

## Criteria
- [x] ISC-1: a
- [x] ISC-2: b
- [x] ISC-3: c

## Verification
- ISC-1: ok
- ISC-2: ok
- ISC-3: ok
`

describe("PreCompact preserves ISA paths into snapshot + additionalContext", () => {
  test("snapshot file includes `## Active ISAs` with project + task ISA", async () => {
    const { root, cleanup } = stage()
    try {
      writeProjectIsa(root, ISA_BUILD)
      writeTaskIsa(root, "20260509_t", ISA_BUILD)

      const payload = decode({
        _tag: "PreCompact",
        session_id: "sess1",
        hook_event_name: "PreCompact",
        trigger: "manual",
        cwd: root,
      })
      const decision = await Effect.runPromise(
        handlePreCompact(payload).pipe(
          Effect.provide(FileSystemLive),
          Effect.provide(SessionStateLive(root)),
          Effect.provide(projectAt(root)),
        ),
      )
      const out = decision as {
        hookSpecificOutput?: { additionalContext?: string }
      }
      // Inline additionalContext line carries an `active_isas:` field
      expect(out.hookSpecificOutput?.additionalContext ?? "").toContain(
        "active_isas:",
      )
      expect(out.hookSpecificOutput?.additionalContext ?? "").toContain(
        "ISA.md",
      )

      // Snapshot file written to compact-snapshots dir
      const snapshotsDir = join(root, ".claude-hooks", "state", "compact-snapshots")
      expect(existsSync(snapshotsDir)).toBe(true)
      const files = readFileSync(snapshotsDir + "/" +
        // pick any file matching our session prefix
        require("node:fs").readdirSync(snapshotsDir).find((f: string) => f.startsWith("sess1-")),
        "utf-8",
      )
      expect(files).toContain("## Active ISAs")
      expect(files).toContain("project ISA")
      expect(files).toContain("task ISA")
      expect(files).toContain("phase: build")
      expect(files).toContain("Ship the OAuth refresh")
    } finally {
      cleanup()
    }
  })

  test("snapshot indicates no ISAs when neither project nor task ISA present", async () => {
    const { root, cleanup } = stage()
    try {
      const payload = decode({
        _tag: "PreCompact",
        session_id: "sess2",
        hook_event_name: "PreCompact",
        trigger: "manual",
        cwd: root,
      })
      await Effect.runPromise(
        handlePreCompact(payload).pipe(
          Effect.provide(FileSystemLive),
          Effect.provide(SessionStateLive(root)),
          Effect.provide(projectAt(root)),
        ),
      )
      const snapshotsDir = join(root, ".claude-hooks", "state", "compact-snapshots")
      const fileName = require("node:fs")
        .readdirSync(snapshotsDir)
        .find((f: string) => f.startsWith("sess2-"))
      const md = readFileSync(join(snapshotsDir, fileName), "utf-8")
      expect(md).toContain("## Active ISAs")
      expect(md).toContain("(no ISAs found")
    } finally {
      cleanup()
    }
  })
})

describe("PostCompact rehydrates ISA section as additionalContext", () => {
  test("reads the latest snapshot for the session and emits ISAs section", async () => {
    const { root, cleanup } = stage()
    try {
      writeProjectIsa(root, ISA_BUILD)

      // Run PreCompact to produce a snapshot
      const pre = decode({
        _tag: "PreCompact",
        session_id: "rehy1",
        hook_event_name: "PreCompact",
        trigger: "manual",
        cwd: root,
      })
      await Effect.runPromise(
        handlePreCompact(pre).pipe(
          Effect.provide(FileSystemLive),
          Effect.provide(SessionStateLive(root)),
          Effect.provide(projectAt(root)),
        ),
      )

      // Now PostCompact — should rehydrate the ISA section
      const post = decode({
        _tag: "PostCompact",
        session_id: "rehy1",
        hook_event_name: "PostCompact",
        trigger: "manual",
        cwd: root,
      })
      const decision = await Effect.runPromise(
        handlePostCompact(post).pipe(
          Effect.provide(FileSystemLive),
          Effect.provide(projectAt(root)),
        ),
      )
      const out = decision as {
        hookSpecificOutput?: { additionalContext?: string }
      }
      expect(out.hookSpecificOutput?.additionalContext ?? "").toContain(
        "Rehydrated ISA context",
      )
      expect(out.hookSpecificOutput?.additionalContext ?? "").toContain(
        "ISA.md",
      )
      expect(out.hookSpecificOutput?.additionalContext ?? "").toContain(
        "phase: build",
      )
    } finally {
      cleanup()
    }
  })

  test("returns SAFE_DEFAULT when no snapshot exists for the session", async () => {
    const { root, cleanup } = stage()
    try {
      const post = decode({
        _tag: "PostCompact",
        session_id: "missing",
        hook_event_name: "PostCompact",
        trigger: "manual",
        cwd: root,
      })
      const decision = await Effect.runPromise(
        handlePostCompact(post).pipe(
          Effect.provide(FileSystemLive),
          Effect.provide(projectAt(root)),
        ),
      )
      expect(decision).toEqual({})
    } finally {
      cleanup()
    }
  })

  test("snapshot without `## Active ISAs` section → SAFE_DEFAULT (back-compat with older snapshots)", async () => {
    const { root, cleanup } = stage()
    try {
      // Create a snapshot manually that lacks the new section
      const dir = join(root, ".claude-hooks", "state", "compact-snapshots")
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, "old-2026-05-09T00_00_00Z.md"),
        "# Old snapshot\n\n## Files changed\n  - x\n",
        "utf-8",
      )
      const post = decode({
        _tag: "PostCompact",
        session_id: "old",
        hook_event_name: "PostCompact",
        cwd: root,
      })
      const decision = await Effect.runPromise(
        handlePostCompact(post).pipe(
          Effect.provide(FileSystemLive),
          Effect.provide(projectAt(root)),
        ),
      )
      expect(decision).toEqual({})
    } finally {
      cleanup()
    }
  })
})

describe("SessionEnd archives `phase: complete` ISAs", () => {
  test("project ISA in `phase: complete` → copied to archive/<date>/project/ISA.md", async () => {
    const { root, cleanup } = stage()
    try {
      writeProjectIsa(root, ISA_COMPLETE)
      const end = decode({
        _tag: "SessionEnd",
        session_id: "end1",
        hook_event_name: "SessionEnd",
        cwd: root,
      })
      await Effect.runPromise(
        handleSessionEnd(end).pipe(
          Effect.provide(FileSystemLive),
          Effect.provide(SessionStateLive(root)),
          Effect.provide(projectAt(root)),
        ),
      )
      // Find archive dir — date is today's YYYY-MM-DD; under tracked
      // .claude-hooks/archive/ (NOT .claude-hooks/state/archive/).
      const today = new Date().toISOString().slice(0, 10)
      const archived = join(
        root,
        ".claude-hooks",
        "archive",
        today,
        "project",
        "ISA.md",
      )
      expect(existsSync(archived)).toBe(true)
      expect(readFileSync(archived, "utf-8")).toContain("phase: complete")
    } finally {
      cleanup()
    }
  })

  test("task ISA in `phase: complete` → copied to archive/<date>/<slug>/ISA.md", async () => {
    const { root, cleanup } = stage()
    try {
      writeTaskIsa(root, "20260509_taskdone", ISA_COMPLETE)
      const end = decode({
        _tag: "SessionEnd",
        session_id: "end2",
        hook_event_name: "SessionEnd",
        cwd: root,
      })
      await Effect.runPromise(
        handleSessionEnd(end).pipe(
          Effect.provide(FileSystemLive),
          Effect.provide(SessionStateLive(root)),
          Effect.provide(projectAt(root)),
        ),
      )
      const today = new Date().toISOString().slice(0, 10)
      const archived = join(
        root,
        ".claude-hooks",
        "archive",
        today,
        "20260509_taskdone",
        "ISA.md",
      )
      expect(existsSync(archived)).toBe(true)
    } finally {
      cleanup()
    }
  })

  test("ISA in `phase: build` → NOT archived (only complete archives)", async () => {
    const { root, cleanup } = stage()
    try {
      writeProjectIsa(root, ISA_BUILD)
      const end = decode({
        _tag: "SessionEnd",
        session_id: "end3",
        hook_event_name: "SessionEnd",
        cwd: root,
      })
      await Effect.runPromise(
        handleSessionEnd(end).pipe(
          Effect.provide(FileSystemLive),
          Effect.provide(SessionStateLive(root)),
          Effect.provide(projectAt(root)),
        ),
      )
      const today = new Date().toISOString().slice(0, 10)
      const archiveDir = join(
        root,
        ".claude-hooks",
        "state",
        "archive",
        today,
      )
      expect(existsSync(archiveDir)).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("no ISA at cwd → SessionEnd proceeds without errors", async () => {
    const { root, cleanup } = stage()
    try {
      const end = decode({
        _tag: "SessionEnd",
        session_id: "end4",
        hook_event_name: "SessionEnd",
        cwd: root,
      })
      const decision = await Effect.runPromise(
        handleSessionEnd(end).pipe(
          Effect.provide(FileSystemLive),
          Effect.provide(SessionStateLive(root)),
          Effect.provide(projectAt(root)),
        ),
      )
      expect(decision).toEqual({})
      // Pre-existing session-summary still wrote
      expect(
        existsSync(join(root, ".claude-hooks", "state", "sessions", "end4.md")),
      ).toBe(true)
    } finally {
      cleanup()
    }
  })
})
