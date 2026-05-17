import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { handleCwdChanged } from "../../src/events/cwd-changed.ts";
import { HookPayload } from "../../src/schema/payloads.ts";
import { FileSystemTest } from "../../src/services/filesystem.ts";
import { ShellTest, type ShellResult } from "../../src/services/shell.ts";
import {
  SessionState,
  SessionStateTest,
  EMPTY_SESSION_STATE,
} from "../../src/services/session-state.ts";

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw);

const shellRoots = (
  prevRoot: string | null,
  newRoot: string | null,
  prevCwd: string,
  newCwd: string,
) =>
  ShellTest((cmd: string): ShellResult => {
    if (cmd.includes(`'${prevCwd}'`)) {
      return prevRoot === null
        ? { stdout: "", stderr: "no", exitCode: 1 }
        : { stdout: prevRoot + "\n", stderr: "", exitCode: 0 };
    }
    if (cmd.includes(`'${newCwd}'`)) {
      return newRoot === null
        ? { stdout: "", stderr: "no", exitCode: 1 }
        : { stdout: newRoot + "\n", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 1 };
  });

describe("handleCwdChanged", () => {
  test("injects context when new_cwd has .claude-hooks/ (no project switch)", async () => {
    const layer = Layer.mergeAll(
      FileSystemTest(new Map([["/new/.claude-hooks", ""]])),
      shellRoots(null, null, "/old", "/new"),
      SessionStateTest(),
    );
    const payload = decode({
      _tag: "CwdChanged",
      session_id: "s1",
      hook_event_name: "CwdChanged",
      previous_cwd: "/old",
      new_cwd: "/new",
    });
    const d = await Effect.runPromise(
      handleCwdChanged(payload).pipe(Effect.provide(layer)),
    );
    expect(
      (d as { hookSpecificOutput: { additionalContext: string } })
        .hookSpecificOutput.additionalContext,
    ).toContain("/new/.claude-hooks/");
  });

  test("NO_DECISION when no project-local config and same git root", async () => {
    const layer = Layer.mergeAll(
      FileSystemTest(),
      shellRoots("/repo", "/repo", "/repo/a", "/repo/b"),
      SessionStateTest(),
    );
    const payload = decode({
      _tag: "CwdChanged",
      session_id: "s1",
      hook_event_name: "CwdChanged",
      previous_cwd: "/repo/a",
      new_cwd: "/repo/b",
    });
    const d = await Effect.runPromise(
      handleCwdChanged(payload).pipe(Effect.provide(layer)),
    );
    expect(d).toEqual({});
  });

  // FIXES: engagement freeze must survive a project switch.
  //
  // P2 — when engagement_required is true, a confirmed project switch must
  // NOT reset SessionState. The frozen engagement fields (session_root,
  // expected_isa_path_absolute, engagement_required) are the only way the
  // Stop/PostTool/TaskCompleted gates know which ISA is the active one.
  test("engaged project switch PRESERVES frozen engagement fields (no reset)", async () => {
    const layer = Layer.mergeAll(
      FileSystemTest(),
      shellRoots("/repo-a", "/repo-b", "/repo-a", "/repo-b"),
      SessionStateTest(
        new Map([
          [
            "s1",
            {
              ...EMPTY_SESSION_STATE,
              engagement_required: true,
              session_root: "/repo-a",
              expected_isa_path: ".claude-hooks/work/slug/ISA.md",
              expected_isa_path_absolute:
                "/repo-a/.claude-hooks/work/slug/ISA.md",
              last_tier: 3,
            },
          ],
        ]),
      ),
    );
    const payload = decode({
      _tag: "CwdChanged",
      session_id: "s1",
      hook_event_name: "CwdChanged",
      previous_cwd: "/repo-a",
      new_cwd: "/repo-b",
    });
    const program = Effect.gen(function* () {
      const d = yield* handleCwdChanged(payload);
      const s = yield* SessionState;
      const after = yield* s.get("s1");
      return { d, after };
    });
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)));
    expect(r.after.engagement_required).toBe(true);
    expect(r.after.session_root).toBe("/repo-a");
    expect(r.after.expected_isa_path_absolute).toBe(
      "/repo-a/.claude-hooks/work/slug/ISA.md",
    );
    expect(r.after.last_tier).toBe(3);
    // Advisory context may still be emitted; just don't claim the reset happened.
    const ctx =
      (r.d as { hookSpecificOutput?: { additionalContext?: string } })
        .hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).not.toContain("Session state reset.");
  });

  test("project switch resets session state and injects context", async () => {
    const layer = Layer.mergeAll(
      FileSystemTest(),
      shellRoots("/repo-a", "/repo-b", "/repo-a", "/repo-b"),
      SessionStateTest(
        new Map([
          [
            "s1",
            {
              ...EMPTY_SESSION_STATE,
              files_changed: ["/repo-a/x.ts"],
              verification_status: "passed" as const,
            },
          ],
        ]),
      ),
    );
    const payload = decode({
      _tag: "CwdChanged",
      session_id: "s1",
      hook_event_name: "CwdChanged",
      previous_cwd: "/repo-a",
      new_cwd: "/repo-b",
    });
    const program = Effect.gen(function* () {
      const d = yield* handleCwdChanged(payload);
      const s = yield* SessionState;
      const after = yield* s.get("s1");
      return { d, after };
    });
    const r = await Effect.runPromise(program.pipe(Effect.provide(layer)));
    const ctx = (r.d as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(ctx).toContain("Switched to project repo-b");
    expect(ctx).toContain("Session state reset.");
    expect(r.after.files_changed).toEqual([]);
    expect(r.after.verification_status).toBe("none");
  });
});
