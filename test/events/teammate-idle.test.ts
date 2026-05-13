import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleTeammateIdle } from "../../src/events/teammate-idle.ts";
import { HookPayload } from "../../src/schema/payloads.ts";
import { EventStoreLive } from "../../src/services/event-store.ts";
import { ProjectTest } from "../../src/services/project.ts";
import {
  SessionStateTest,
  EMPTY_SESSION_STATE,
} from "../../src/services/session-state.ts";

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw);

const payloadFor = (sid: string) =>
  decode({
    _tag: "TeammateIdle",
    session_id: sid,
    hook_event_name: "TeammateIdle",
    teammate_name: "researcher",
    teammate_type: "subagent",
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
});
