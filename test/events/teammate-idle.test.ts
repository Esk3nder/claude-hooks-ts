import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { handleTeammateIdle } from "../../src/events/teammate-idle.ts";
import { HookPayload } from "../../src/schema/payloads.ts";
import { FileSystem, FileSystemTest } from "../../src/services/filesystem.ts";
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
  test("ledger entry + SAFE_DEFAULT for empty state", async () => {
    const layer = Layer.mergeAll(
      FileSystemTest(),
      ProjectTest({ root: "/proj" }),
      SessionStateTest(),
    );
    const payload = payloadFor("s1");
    const program = Effect.gen(function* () {
      const d = yield* handleTeammateIdle(payload);
      const fs = yield* FileSystem;
      const c = yield* fs.readFile(
        "/proj/.claude-hooks/state/teammate-idle.jsonl",
      );
      return { d, c };
    });
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)));
    expect(r.d).toEqual({});
    expect(JSON.parse(r.c.trim()).teammate_name).toBe("researcher");
  });

  test("SAFE_DEFAULT when files_changed but verification passed", async () => {
    const layer = Layer.mergeAll(
      FileSystemTest(),
      ProjectTest({ root: "/proj" }),
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
  });

  test("blocks when files_changed and verification not passed", async () => {
    const layer = Layer.mergeAll(
      FileSystemTest(),
      ProjectTest({ root: "/proj" }),
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
    const out = d as { continue: boolean; stopReason: string };
    expect(out.continue).toBe(false);
    expect(out.stopReason).toContain("Files changed (2)");
  });
});
