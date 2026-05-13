import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema, Stream } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handlePostCompact } from "../../src/events/postcompact-ledger.ts";
import { EventStoreError } from "../../src/schema/errors.ts";
import { HookPayload } from "../../src/schema/payloads.ts";
import { EventStore, EventStoreLive } from "../../src/services/event-store.ts";
import { ProjectTest } from "../../src/services/project.ts";

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw);

const postCompact = (sid: string, trigger?: string) =>
  decode({
    _tag: "PostCompact",
    session_id: sid,
    hook_event_name: "PostCompact",
    ...(trigger !== undefined ? { trigger } : {}),
  });

describe("handlePostCompact", () => {
  test("appends ledger entry, returns SAFE_DEFAULT", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "chts-postcompact-"));
    try {
      const layer = Layer.mergeAll(EventStoreLive, ProjectTest({ root }));
      const decision = await Effect.runPromise(
        handlePostCompact(postCompact("sid-1", "auto")).pipe(Effect.provide(layer)),
      );
      const content = fs.readFileSync(
        path.join(root, ".claude-hooks", "state", "postcompact-ledger.jsonl"),
        "utf8",
      );
      expect(decision).toEqual({});
      expect(content).toContain('"session_id":"sid-1"');
      expect(content).toContain('"trigger":"auto"');
      expect(content).toContain('"snapshot_path"');
      expect(content.endsWith("\n")).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("ledger write failure → still returns SAFE_DEFAULT and emits stderr", async () => {
    const failingStore = Layer.succeed(
      EventStore,
      EventStore.of({
        append: () =>
          Effect.fail(new EventStoreError({ op: "append", stream: "x", path: "x", message: "boom-write" })),
        tail: () => Stream.empty,
        compact: () => Effect.void,
      }),
    );
    const layer = Layer.mergeAll(failingStore, ProjectTest({ root: "/proj" }));

    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (
      chunk: string | Uint8Array,
    ): boolean => {
      const s2 =
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      captured.push(s2);
      return true;
    };
    try {
      const d = await Effect.runPromise(
        handlePostCompact(postCompact("sid-fail")).pipe(Effect.provide(layer)),
      );
      expect(d).toEqual({});
      const joined = captured.join("");
      expect(joined).toContain("postcompact-ledger:");
      expect(joined).toContain("write failed:");
    } finally {
      (process.stderr.write as unknown) = origWrite;
    }
  });

  test("non-PostCompact payload → SAFE_DEFAULT", async () => {
    const layer = Layer.mergeAll(
      EventStoreLive,
      ProjectTest({ root: "/proj" }),
    );
    const payload = decode({
      _tag: "Stop",
      session_id: "s",
      hook_event_name: "Stop",
    });
    const d = await Effect.runPromise(
      handlePostCompact(payload).pipe(Effect.provide(layer)),
    );
    expect(d).toEqual({});
  });
});
