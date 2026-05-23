import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  SessionState,
  SessionStateTest,
  EMPTY_SESSION_STATE,
  engagementOf,
  verificationOf,
  modeCacheOf,
} from "../../src/services/session-state.ts";

describe("SessionState (test layer)", () => {
  test("get returns empty record for unknown session", async () => {
    const program = Effect.gen(function* () {
      const s = yield* SessionState;
      return yield* s.get("missing");
    });
    const r = await Effect.runPromise(
      program.pipe(Effect.provide(SessionStateTest())),
    );
    expect(r).toEqual(EMPTY_SESSION_STATE);
  });

  test("US-14: probe_verified_iscs defaults to [] in EMPTY_SESSION_STATE (back-compat)", () => {
    // Pin the default so a future refactor that drops the field can't
    // silently break the Stop completeness gate's provenance check.
    expect(EMPTY_SESSION_STATE.probe_verified_iscs).toEqual([]);
  });

  test("meta_artifacts_changed defaults to [] in EMPTY_SESSION_STATE", () => {
    expect(EMPTY_SESSION_STATE.meta_artifacts_changed).toEqual([]);
  });

  test("US-14: append('probe_verified_iscs', iscId) persists across get()", async () => {
    const program = Effect.gen(function* () {
      const s = yield* SessionState;
      yield* s.append("sid", "probe_verified_iscs", "ISC-1");
      yield* s.append("sid", "probe_verified_iscs", "ISC-2");
      return yield* s.get("sid");
    });
    const r = await Effect.runPromise(
      program.pipe(Effect.provide(SessionStateTest())),
    );
    expect(r.probe_verified_iscs).toEqual(["ISC-1", "ISC-2"]);
  });

  test("update merges patch", async () => {
    const program = Effect.gen(function* () {
      const s = yield* SessionState;
      yield* s.update("sid", { verification_status: "passed" });
      return yield* s.get("sid");
    });
    const r = await Effect.runPromise(
      program.pipe(Effect.provide(SessionStateTest())),
    );
    expect(r.verification_status).toBe("passed");
  });

  test("append deduplicates", async () => {
    const program = Effect.gen(function* () {
      const s = yield* SessionState;
      yield* s.append("sid", "files_changed", "/a");
      yield* s.append("sid", "files_changed", "/a");
      yield* s.append("sid", "files_changed", "/b");
      return yield* s.get("sid");
    });
    const r = await Effect.runPromise(
      program.pipe(Effect.provide(SessionStateTest())),
    );
    expect(r.files_changed).toEqual(["/a", "/b"]);
  });

  test("stop_blocked_once flag round-trips", async () => {
    const program = Effect.gen(function* () {
      const s = yield* SessionState;
      yield* s.update("sid", { stop_blocked_once: true });
      return yield* s.get("sid");
    });
    const r = await Effect.runPromise(
      program.pipe(Effect.provide(SessionStateTest())),
    );
    expect(r.stop_blocked_once).toBe(true);
  });
  test("reset clears arrays and resets verification_status", async () => {
    const program = Effect.gen(function* () {
      const s = yield* SessionState;
      yield* s.append("sid", "files_changed", "/a");
      yield* s.append("sid", "meta_artifacts_changed", "/meta");
      yield* s.append("sid", "commands_run", "ls");
      yield* s.append("sid", "tests_run", "t1");
      yield* s.update("sid", { verification_status: "passed" });
      yield* s.reset("sid");
      return yield* s.get("sid");
    });
    const r = await Effect.runPromise(
      program.pipe(Effect.provide(SessionStateTest())),
    );
    expect(r.files_changed).toEqual([]);
    expect(r.meta_artifacts_changed).toEqual([]);
    expect(r.commands_run).toEqual([]);
    expect(r.tests_run).toEqual([]);
    expect(r.verification_status).toBe("none");
  });
});

describe("SessionStateRecord — focused sub-record projections", () => {
  // The split is type-level + projection-helpers only; the on-disk record
  // stays unified. These tests pin (a) that each projection returns
  // exactly the fields the owning concern needs and (b) that the three
  // slices partition the record cleanly with no overlap.
  test("engagementOf returns engagement-owned fields only", () => {
    const r = {
      ...EMPTY_SESSION_STATE,
      engagement_required: true,
      expected_isa_path: ".claude-hooks/work/x/ISA.md",
      session_root: "/tmp/root",
      expected_isa_path_absolute: "/tmp/root/.claude-hooks/work/x/ISA.md",
      isa_engaged_at: "2026-05-11T00:00:00.000Z",
      last_tier: 3,
      stop_blocked_once: true,
      // mode-cache / verification fields below — must NOT leak into the
      // engagement projection.
      last_mode: "ALGORITHM",
      last_workflow: "research.foo",
      files_changed: ["/a"],
      verification_status: "passed" as const,
    };
    expect(engagementOf(r)).toEqual({
      engagement_required: true,
      expected_isa_path: ".claude-hooks/work/x/ISA.md",
      session_root: "/tmp/root",
      expected_isa_path_absolute: "/tmp/root/.claude-hooks/work/x/ISA.md",
      isa_engaged_at: "2026-05-11T00:00:00.000Z",
      last_tier: 3,
      stop_blocked_once: true,
      regenerate_skipped: [],
    });
  });

  test("verificationOf returns ledger fields only", () => {
    const r = {
      ...EMPTY_SESSION_STATE,
      files_changed: ["/a"],
      meta_artifacts_changed: ["/meta"],
      commands_run: ["ls"],
      tests_run: ["t1"],
      verification_status: "passed" as const,
      next_required_action: "go",
      subagent_starts: ["sub1"],
      subagent_stops: ["sub1"],
      // engagement / mode fields — must not leak
      engagement_required: true,
      last_mode: "ALGORITHM",
      source_urls: ["http://x"],
    };
    const v = verificationOf(r);
    expect(v.files_changed).toEqual(["/a"]);
    expect(v.meta_artifacts_changed).toEqual(["/meta"]);
    expect(v.verification_status).toBe("passed");
    // Cast through `unknown` because VerificationLedger has no string index
    // signature — we're inspecting that fields from other slices did NOT
    // leak into the projection result.
    expect((v as unknown as Record<string, unknown>)["engagement_required"]).toBeUndefined();
    expect((v as unknown as Record<string, unknown>)["source_urls"]).toBeUndefined();
  });

  test("modeCacheOf returns mode/workflow/source-url fields only", () => {
    const r = {
      ...EMPTY_SESSION_STATE,
      last_mode: "ALGORITHM",
      last_workflow: "research.foo",
      source_urls: ["http://x"],
      // engagement field — must not leak
      engagement_required: true,
      last_tier: 3,
    };
    expect(modeCacheOf(r)).toEqual({
      last_mode: "ALGORITHM",
      last_workflow: "research.foo",
      source_urls: ["http://x"],
      requires_web_sources: false,
      source_ledger_opt_out: false,
    });
  });
});
