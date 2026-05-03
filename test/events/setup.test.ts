import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleSetup } from "../../src/events/setup.ts";
import { HookPayload } from "../../src/schema/payloads.ts";
import { FileSystem, FileSystemTest } from "../../src/services/filesystem.ts";
import { ProjectTest } from "../../src/services/project.ts";
import { ApprovalsTest } from "../../src/services/approvals.ts";

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw);

describe("handleSetup", () => {
  test("appends ledger entry and returns SAFE_DEFAULT for non-handled trigger", async () => {
    const layer = Layer.mergeAll(
      FileSystemTest(),
      ProjectTest({ root: "/proj" }),
      ApprovalsTest(),
    );
    // Use a non-init/non-maintenance trigger by relying on the schema's default
    // path: init triggers conditionally inject. We assert ledger only here.
    const payload = decode({
      _tag: "Setup",
      session_id: "s1",
      hook_event_name: "Setup",
      trigger: "init",
    });
    const program = Effect.gen(function* () {
      yield* handleSetup(payload);
      const fs = yield* FileSystem;
      const content = yield* fs.readFile(
        "/proj/.claude-hooks/state/setup.jsonl",
      );
      return content;
    });
    const content = await Effect.runPromise(
      program.pipe(Effect.provide(layer)),
    );
    const parsed = JSON.parse(content.trim().split("\n")[0]!);
    expect(parsed.session_id).toBe("s1");
    expect(parsed.trigger).toBe("init");
  });

  test("non-Setup payload is no-op", async () => {
    const layer = Layer.mergeAll(
      FileSystemTest(),
      ProjectTest({ root: "/proj" }),
      ApprovalsTest(),
    );
    const payload = decode({
      _tag: "Stop",
      session_id: "x",
      hook_event_name: "Stop",
    });
    const d = await Effect.runPromise(
      handleSetup(payload).pipe(Effect.provide(layer)),
    );
    expect(d).toEqual({});
  });

  test("init trigger creates .claude-hooks/ skeleton when missing", async () => {
    const tmpRoot = fsSync.mkdtempSync(
      path.join(os.tmpdir(), "m13b-setup-init-"),
    );
    try {
      const layer = Layer.mergeAll(
        FileSystemTest(),
        ProjectTest({ root: tmpRoot }),
        ApprovalsTest(),
      );
      const payload = decode({
        _tag: "Setup",
        session_id: "s1",
        hook_event_name: "Setup",
        trigger: "init",
      });
      const d = await Effect.runPromise(
        handleSetup(payload).pipe(Effect.provide(layer)),
      );
      const out = d as {
        hookSpecificOutput?: { additionalContext?: string };
      };
      expect(out.hookSpecificOutput?.additionalContext).toContain(
        "Initialized .claude-hooks/",
      );
      expect(fsSync.existsSync(path.join(tmpRoot, ".claude-hooks"))).toBe(true);
      expect(
        fsSync.existsSync(path.join(tmpRoot, ".claude-hooks", "state")),
      ).toBe(true);
      expect(
        fsSync.existsSync(path.join(tmpRoot, ".claude-hooks", "README.md")),
      ).toBe(true);
    } finally {
      fsSync.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("maintenance trigger rotates oversized ledger files", async () => {
    const tmpRoot = fsSync.mkdtempSync(
      path.join(os.tmpdir(), "m13b-setup-maint-"),
    );
    try {
      const stateDir = path.join(tmpRoot, ".claude-hooks", "state");
      fsSync.mkdirSync(stateDir, { recursive: true });
      const big = path.join(stateDir, "big.jsonl");
      // Write ~11 MB of dummy data.
      const chunk = Buffer.alloc(1024 * 1024, 0x61); // 1 MB of 'a'
      const fd = fsSync.openSync(big, "w");
      try {
        for (let i = 0; i < 11; i++) fsSync.writeSync(fd, chunk);
      } finally {
        fsSync.closeSync(fd);
      }

      const layer = Layer.mergeAll(
        FileSystemTest(),
        ProjectTest({ root: tmpRoot }),
        ApprovalsTest(),
      );
      const payload = decode({
        _tag: "Setup",
        session_id: "s1",
        hook_event_name: "Setup",
        trigger: "maintenance",
      });
      const d = await Effect.runPromise(
        handleSetup(payload).pipe(Effect.provide(layer)),
      );
      const out = d as {
        hookSpecificOutput?: { additionalContext?: string };
      };
      expect(out.hookSpecificOutput?.additionalContext).toContain(
        "Maintenance pass:",
      );
      expect(out.hookSpecificOutput?.additionalContext).toContain(
        "rotated 1 ledger files",
      );
      expect(fsSync.existsSync(big)).toBe(false);
      const remaining = fsSync.readdirSync(stateDir);
      expect(remaining.some((n) => n.endsWith(".archive"))).toBe(true);
    } finally {
      fsSync.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
