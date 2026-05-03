import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleInstructionsLoaded } from "../../src/events/instructions-loaded.ts";
import { HookPayload } from "../../src/schema/payloads.ts";
import { FileSystem, FileSystemTest } from "../../src/services/filesystem.ts";
import { ProjectTest } from "../../src/services/project.ts";

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw);

describe("handleInstructionsLoaded", () => {
  test("captures file_path / memory_type / load_reason; SAFE_DEFAULT for fresh file", async () => {
    const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "m13b-il-fresh-"));
    try {
      const file = path.join(tmp, "CLAUDE.md");
      fsSync.writeFileSync(file, "# fresh\n");
      const layer = Layer.mergeAll(
        FileSystemTest(),
        ProjectTest({ root: "/proj" }),
      );
      const payload = decode({
        _tag: "InstructionsLoaded",
        session_id: "s1",
        hook_event_name: "InstructionsLoaded",
        file_path: file,
        memory_type: "Project",
        load_reason: "session_start",
      });
      const program = Effect.gen(function* () {
        const d = yield* handleInstructionsLoaded(payload);
        const fs = yield* FileSystem;
        const c = yield* fs.readFile(
          "/proj/.claude-hooks/state/instructions-loaded.jsonl",
        );
        return { d, c };
      });
      const r = await Effect.runPromise(program.pipe(Effect.provide(layer)));
      expect(r.d).toEqual({});
      const e = JSON.parse(r.c.trim());
      expect(e.file_path).toBe(file);
      expect(e.memory_type).toBe("Project");
      expect(e.load_reason).toBe("session_start");
    } finally {
      fsSync.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("warns when CLAUDE.md is older than 30 days", async () => {
    const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "m13b-il-stale-"));
    try {
      const file = path.join(tmp, "CLAUDE.md");
      fsSync.writeFileSync(file, "# stale\n");
      const past = (Date.now() - 31 * 24 * 60 * 60 * 1000) / 1000;
      fsSync.utimesSync(file, past, past);
      const layer = Layer.mergeAll(
        FileSystemTest(),
        ProjectTest({ root: "/proj" }),
      );
      const payload = decode({
        _tag: "InstructionsLoaded",
        session_id: "s1",
        hook_event_name: "InstructionsLoaded",
        file_path: file,
        memory_type: "Project",
        load_reason: "session_start",
      });
      const d = await Effect.runPromise(
        handleInstructionsLoaded(payload).pipe(Effect.provide(layer)),
      );
      const ctx = (d as { hookSpecificOutput: { additionalContext: string } })
        .hookSpecificOutput.additionalContext;
      expect(ctx).toContain("CLAUDE.md is");
      expect(ctx).toContain("days old");
    } finally {
      fsSync.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("flags third-party hook tooling (bifrost-XYZ.md)", async () => {
    const layer = Layer.mergeAll(
      FileSystemTest(),
      ProjectTest({ root: "/proj" }),
    );
    const payload = decode({
      _tag: "InstructionsLoaded",
      session_id: "s1",
      hook_event_name: "InstructionsLoaded",
      file_path: "/some/path/bifrost-abc123.md",
      memory_type: "User",
      load_reason: "session_start",
    });
    const d = await Effect.runPromise(
      handleInstructionsLoaded(payload).pipe(Effect.provide(layer)),
    );
    const ctx = (d as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(ctx).toContain("Third-party hook tooling detected");
    expect(ctx).toContain("bifrost-abc123.md");
  });
});
