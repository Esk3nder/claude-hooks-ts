import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleTeammateIdle } from "../../src/events/teammate-idle.ts";
import { AppTest } from "../../src/layers/test.ts";
import { HookPayload } from "../../src/schema/payloads.ts";
import { EventStoreLive } from "../../src/services/event-store.ts";
import { ProjectTest } from "../../src/services/project.ts";
import {
  SessionState,
  SessionStateTest,
  EMPTY_SESSION_STATE,
} from "../../src/services/session-state.ts";
import { WorkerRuns } from "../../src/services/worker-runs.ts";
import type { WorkerResult } from "../../src/schema/worker-run.ts";

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw);

const payloadFor = (sid: string) =>
  decode({
    _tag: "TeammateIdle",
    session_id: sid,
    hook_event_name: "TeammateIdle",
    teammate_name: "researcher",
    teammate_type: "subagent",
  });

const workerResult = (): WorkerResult => ({
  summary: "worker changed files",
  files_relevant: [],
  changes_made: [{ path: "src/a.ts", summary: "changed" }],
  commands_run: [],
  verification: [{ check: "unit", status: "passed", evidence: "passed" }],
  risks: [],
  blockers: [],
  confidence: "high",
});

describe("handleTeammateIdle", () => {
  test("ledger entry + NO_DECISION for empty state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "chts-teammate-idle-"));
    try {
      const layer = Layer.mergeAll(
        EventStoreLive,
        ProjectTest({ root }),
        SessionStateTest(),
      );
      const payload = payloadFor("s1");
      const d = await Effect.runPromise(handleTeammateIdle(payload).pipe(Effect.provide(layer)));
      const c = fs.readFileSync(path.join(root, ".claude-hooks", "state", "teammate-idle.jsonl"), "utf8");
      expect(d).toEqual({});
      expect(JSON.parse(c.trim()).teammate_name).toBe("researcher");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("NO_DECISION when files_changed but verification passed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "chts-teammate-idle-"));
    try {
      const layer = Layer.mergeAll(
        EventStoreLive,
        ProjectTest({ root }),
        SessionStateTest(
          new Map([
            [
              "s2",
              {
                ...EMPTY_SESSION_STATE,
                files_changed: ["/x.ts"],
                verification_status: "passed" as const,
              },
            ],
          ]),
        ),
      );
      const d = await Effect.runPromise(
        handleTeammateIdle(payloadFor("s2")).pipe(Effect.provide(layer)),
      );
      expect(d).toEqual({});
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks when files_changed and verification not passed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "chts-teammate-idle-"));
    try {
      const layer = Layer.mergeAll(
        EventStoreLive,
        ProjectTest({ root }),
        SessionStateTest(
          new Map([
            [
              "s3",
              {
                ...EMPTY_SESSION_STATE,
                files_changed: ["/a.ts", "/b.ts"],
                verification_status: "none" as const,
              },
            ],
          ]),
        ),
      );
      const d = await Effect.runPromise(
        handleTeammateIdle(payloadFor("s3")).pipe(Effect.provide(layer)),
      );
      const out = d as { decision: string; reason: string };
      expect(out.decision).toBe("block");
      expect(out.reason).toContain("Files changed (2)");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks idle while worker patch integration is pending", async () => {
    const d = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* WorkerRuns;
        yield* runs.createQueued({
          worker_id: "worker-patch",
          session_id: "s-worker-patch",
          agent_type: "executor",
          mode: "write-allowed",
          prompt_hash: "prompt-hash",
          scope: "src/**",
        });
        yield* runs.complete("worker-patch", workerResult(), undefined, {
          isolation: "worktree",
          patch_path: "/tmp/worker-patch.patch",
        });
        return yield* handleTeammateIdle(payloadFor("s-worker-patch"));
      }).pipe(Effect.provide(AppTest)),
    );

    const out = d as { decision: string; reason: string };
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("pending integration");
  });

  test("blocks idle until integrated worker changes have parent verification", async () => {
    const d = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* WorkerRuns;
        yield* runs.createQueued({
          worker_id: "worker-verified",
          session_id: "s-worker-final",
          agent_type: "executor",
          mode: "write-allowed",
          prompt_hash: "prompt-hash",
          scope: "src/**",
        });
        yield* runs.complete("worker-verified", workerResult(), undefined, {
          isolation: "worktree",
          patch_path: "/tmp/worker-verified.patch",
        });
        yield* runs.markIntegrated("worker-verified");
        return yield* handleTeammateIdle(payloadFor("s-worker-final"));
      }).pipe(Effect.provide(AppTest)),
    );

    const out = d as { decision: string; reason: string };
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("final parent-workspace verification");
  });

  test("blocks idle when write-worker changes were never isolated", async () => {
    const d = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* WorkerRuns;
        const state = yield* SessionState;
        yield* runs.createQueued({
          worker_id: "worker-unisolated",
          session_id: "s-worker-unisolated",
          agent_type: "executor",
          mode: "write-allowed",
          prompt_hash: "prompt-hash",
          scope: "src/**",
        });
        yield* runs.complete("worker-unisolated", workerResult());
        yield* state.update("s-worker-unisolated", { verification_status: "passed" });
        return yield* handleTeammateIdle(payloadFor("s-worker-unisolated"));
      }).pipe(Effect.provide(AppTest)),
    );

    const out = d as { decision: string; reason: string };
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("captured isolated patch");
  });

  test("allows idle after integrated worker changes have parent verification", async () => {
    const d = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* WorkerRuns;
        const state = yield* SessionState;
        yield* runs.createQueued({
          worker_id: "worker-safe",
          session_id: "s-worker-safe",
          agent_type: "executor",
          mode: "write-allowed",
          prompt_hash: "prompt-hash",
          scope: "src/**",
        });
        yield* runs.complete("worker-safe", workerResult(), undefined, {
          isolation: "worktree",
          patch_path: "/tmp/worker-safe.patch",
        });
        yield* runs.markIntegrated("worker-safe");
        yield* state.update("s-worker-safe", { verification_status: "passed" });
        return yield* handleTeammateIdle(payloadFor("s-worker-safe"));
      }).pipe(Effect.provide(AppTest)),
    );

    expect(d).toEqual({});
  });
});
