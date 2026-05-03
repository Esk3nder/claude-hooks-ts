import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runInstall,
  runInstallDetailed,
  verifyDispatcherRoundtrip,
} from "../../scripts/install.ts";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

class StringSink {
  buf = "";
  write(chunk: string | Uint8Array): boolean {
    this.buf +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }
}

let tmpDir: string;
let target: string;
const installRoot = "/opt/claude-hooks-ts";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chts-install-"));
  target = path.join(tmpDir, "settings.json");
});
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

const sinkAsStream = (s: StringSink) => s as unknown as NodeJS.WritableStream;

describe("install script (VAL-M5-004)", () => {
  test("dry-run on missing target prints diff and does not create file", () => {
    const out = new StringSink();
    const code = runInstall(
      ["--dry-run", "--target", target, "--install-root", installRoot],
      sinkAsStream(out),
    );
    expect(code).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
    const txt = stripAnsi(out.buf);
    expect(txt).toContain("dry-run");
    expect(txt).toContain("PreToolUse");
    expect(txt).toContain("/opt/claude-hooks-ts/bin/claude-hook");
  });

  test("--apply writes settings atomically", () => {
    const out = new StringSink();
    const code = runInstall(
      ["--apply", "--target", target, "--install-root", installRoot],
      sinkAsStream(out),
    );
    expect(code).toBe(0);
    expect(fs.existsSync(target)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(parsed.hooks["PreToolUse"]?.[0]?.hooks?.[0]?.command).toContain(
      "/opt/claude-hooks-ts/bin/claude-hook PreToolUse",
    );
  });

  test("--apply twice is idempotent (no duplicate hook entries)", () => {
    const noop = new StringSink();
    runInstall(
      ["--apply", "--target", target, "--install-root", installRoot],
      sinkAsStream(noop),
    );
    runInstall(
      ["--apply", "--target", target, "--install-root", installRoot],
      sinkAsStream(noop),
    );
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as {
      hooks: Record<string, Array<{ hooks: unknown[] }>>;
    };
    const matchers = parsed.hooks["Stop"] ?? [];
    expect(matchers.length).toBe(1);
  });

  test("apply over an existing file creates a .bak.<ts> backup", () => {
    fs.writeFileSync(
      target,
      JSON.stringify({ env: { X: "1" } }, null, 2),
      "utf8",
    );
    runInstall(
      ["--apply", "--target", target, "--install-root", installRoot],
      sinkAsStream(new StringSink()),
    );
    const files = fs.readdirSync(tmpDir);
    expect(files.some((f) => f.includes(".bak."))).toBe(true);
  });

  test("preserves unrelated existing hooks/keys", () => {
    const initial = {
      env: { FOO: "bar" },
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "/usr/bin/other-tool" }] },
        ],
      },
    };
    fs.writeFileSync(target, JSON.stringify(initial, null, 2), "utf8");
    runInstall(
      ["--apply", "--target", target, "--install-root", installRoot],
      sinkAsStream(new StringSink()),
    );
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as {
      env: { FOO: string };
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(parsed.env.FOO).toBe("bar");
    const stopMatchers = parsed.hooks["Stop"] ?? [];
    const hasOther = stopMatchers.some((m) =>
      m.hooks.some((h) => h.command === "/usr/bin/other-tool"),
    );
    const hasOurs = stopMatchers.some((m) =>
      m.hooks.some((h) => h.command.includes("claude-hook")),
    );
    expect(hasOther).toBe(true);
    expect(hasOurs).toBe(true);
  });

  test("--uninstall removes our entries but keeps others", () => {
    runInstall(
      ["--apply", "--target", target, "--install-root", installRoot],
      sinkAsStream(new StringSink()),
    );
    const before = JSON.parse(fs.readFileSync(target, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    expect(before.hooks["PreToolUse"]).toBeDefined();
    runInstall(
      [
        "--apply",
        "--uninstall",
        "--target",
        target,
        "--install-root",
        installRoot,
      ],
      sinkAsStream(new StringSink()),
    );
    const after = JSON.parse(fs.readFileSync(target, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    expect(after.hooks["PreToolUse"]).toBeUndefined();
  });
});

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

describe("install post-apply round-trip (M12-B)", () => {
  test("happy path: --apply then verifyDispatcherRoundtrip succeeds with real shim", async () => {
    const out = new StringSink();
    const result = runInstallDetailed(
      ["--apply", "--target", target, "--install-root", REPO_ROOT],
      sinkAsStream(out),
    );
    expect(result.code).toBe(0);
    expect(result.applied).toBe(true);
    const verifyOut = new StringSink();
    const verifyCode = await verifyDispatcherRoundtrip(
      result,
      sinkAsStream(verifyOut),
    );
    expect(verifyCode).toBe(0);
    expect(stripAnsi(verifyOut.buf)).toContain(
      "✓ Dispatcher round-trip verified",
    );
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    expect(parsed.hooks["SessionStart"]).toBeDefined();
  }, 15000);

  test("sad path: broken dispatcher path post-write triggers rollback to backup", async () => {
    const original = { env: { ORIGINAL: "yes" }, hooks: {} };
    fs.writeFileSync(target, JSON.stringify(original, null, 2), "utf8");
    const fakeRoot = path.join(tmpDir, "fake-root");
    fs.mkdirSync(path.join(fakeRoot, "bin"), { recursive: true });
    const out = new StringSink();
    const result = runInstallDetailed(
      ["--apply", "--target", target, "--install-root", fakeRoot],
      sinkAsStream(out),
    );
    expect(result.code).toBe(0);
    expect(result.applied).toBe(true);
    expect(result.backupPath).not.toBeNull();
    const verifyOut = new StringSink();
    const verifyCode = await verifyDispatcherRoundtrip(
      result,
      sinkAsStream(verifyOut),
    );
    expect(verifyCode).toBe(1);
    expect(stripAnsi(verifyOut.buf)).toContain(
      "✗ Round-trip failed; settings rolled back",
    );
    const restored = JSON.parse(fs.readFileSync(target, "utf8")) as {
      env?: { ORIGINAL?: string };
      hooks?: Record<string, unknown>;
    };
    expect(restored.env?.ORIGINAL).toBe("yes");
    expect(restored.hooks).toEqual({});
  }, 15000);

  test("sad path: when no prior file existed, rollback removes the just-written file", async () => {
    expect(fs.existsSync(target)).toBe(false);
    const fakeRoot = path.join(tmpDir, "fake-root");
    fs.mkdirSync(path.join(fakeRoot, "bin"), { recursive: true });
    const out = new StringSink();
    const result = runInstallDetailed(
      ["--apply", "--target", target, "--install-root", fakeRoot],
      sinkAsStream(out),
    );
    expect(result.applied).toBe(true);
    expect(result.backupPath).toBeNull();
    const verifyOut = new StringSink();
    const verifyCode = await verifyDispatcherRoundtrip(
      result,
      sinkAsStream(verifyOut),
    );
    expect(verifyCode).toBe(1);
    expect(fs.existsSync(target)).toBe(false);
  }, 15000);
});
