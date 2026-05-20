/**
 * P0-1 — Concurrency regression pin for checkpoint.
 *
 * Before the fix, `runCheckpoint` did an unlocked `loadState` → mutate →
 * `saveState` against the per-ISA `.checkpoint-state.json` sidecar.
 * Two concurrent checkpoint runs against the same ISA could both load
 * the same prior `committed_iscs[]`, each independently decide to
 * commit a different ISC, and the last `saveState` would overwrite the
 * other's idempotency record — letting that ISC be re-committed by a
 * later checkpoint pass.
 *
 * This pin asserts the new `updateCheckpointState` helper serializes
 * concurrent load → mutate → save calls so no append is lost.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  loadState,
  STATE_FILENAME,
  updateCheckpointState,
} from "../../../src/algorithm/isa/checkpoint.ts"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "checkpoint-concurrency-"))
})

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

describe("checkpoint state concurrency (P0-1)", () => {
  test("10 parallel updateCheckpointState — every ISC id lands", async () => {
    const stateFile = join(root, STATE_FILENAME)
    const N = 10

    const ops = Array.from({ length: N }, (_, i) =>
      updateCheckpointState(stateFile, (prev) => ({
        committed_iscs: [...prev.committed_iscs, `ISC-${i}`],
        last_commit_sha: { ...prev.last_commit_sha, [`repo-${i}`]: `sha-${i}` },
      })),
    )
    await Promise.all(ops)

    const final = loadState(stateFile)
    for (let i = 0; i < N; i++) {
      expect(final.committed_iscs).toContain(`ISC-${i}`)
      expect(final.last_commit_sha[`repo-${i}`]).toBe(`sha-${i}`)
    }
    expect(final.committed_iscs.length).toBe(N)
  })

  test("updateCheckpointState returns the post-mutate state", async () => {
    const stateFile = join(root, STATE_FILENAME)

    const result = await updateCheckpointState(stateFile, (prev) => ({
      committed_iscs: [...prev.committed_iscs, "ISC-only"],
      last_commit_sha: prev.last_commit_sha,
    }))

    expect(result.committed_iscs).toEqual(["ISC-only"])
  })

  test("updateCheckpointState persists JSON readable by loadState", async () => {
    const stateFile = join(root, STATE_FILENAME)

    await updateCheckpointState(stateFile, () => ({
      committed_iscs: ["ISC-a", "ISC-b"],
      last_commit_sha: { "repo-x": "deadbeef" },
    }))

    const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as {
      committed_iscs: string[]
      last_commit_sha: Record<string, string>
    }
    expect(persisted.committed_iscs).toEqual(["ISC-a", "ISC-b"])
    expect(persisted.last_commit_sha).toEqual({ "repo-x": "deadbeef" })
  })
})
