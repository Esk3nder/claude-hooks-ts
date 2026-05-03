import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const DOCTOR_TS = path.join(REPO_ROOT, "scripts", "doctor.ts");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chts-doctor-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const runDoctor = async (
  args: ReadonlyArray<string>,
  envOverrides?: Record<string, string | undefined>,
): Promise<RunResult> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  if (envOverrides) {
    for (const [k, v] of Object.entries(envOverrides)) {
      if (v === undefined) {
        delete env[k];
      } else {
        env[k] = v;
      }
    }
  }
  const proc = Bun.spawn(["bun", "run", DOCTOR_TS, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code: proc.exitCode ?? -1, stdout, stderr };
};

const writeSettingsWithDispatcher = (
  target: string,
  scriptPath: string,
): void => {
  const settings = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: `${scriptPath} SessionStart`,
              timeout: 30,
            },
          ],
        },
      ],
    },
  };
  fs.writeFileSync(target, JSON.stringify(settings, null, 2), "utf8");
};

describe("doctor CLI", () => {
  test("FAIL when settings.json is missing", async () => {
    const target = path.join(tmpDir, "missing.json");
    const res = await runDoctor(["--target", target, "--cwd", tmpDir]);
    const text = stripAnsi(res.stdout);
    expect(text).toContain("[FAIL] settings.json parses");
    expect(text).toContain("read error");
    expect(res.code).toBe(1);
  });

  test("FAIL when settings.json is unparseable", async () => {
    const target = path.join(tmpDir, "settings.json");
    fs.writeFileSync(target, "{ this is not json", "utf8");
    const res = await runDoctor(["--target", target, "--cwd", tmpDir]);
    const text = stripAnsi(res.stdout);
    expect(text).toContain("[FAIL] settings.json parses");
    expect(text).toContain("parse error");
    expect(res.code).toBe(1);
  });

  test("FAIL when wired hook command points at missing script", async () => {
    const target = path.join(tmpDir, "settings.json");
    writeSettingsWithDispatcher(
      target,
      path.join(tmpDir, "does-not-exist", "claude-hook"),
    );
    const res = await runDoctor(["--target", target, "--cwd", tmpDir]);
    const text = stripAnsi(res.stdout);
    expect(text).toContain("[FAIL] wired hook commands resolve");
    expect(text).toContain("missing");
    expect(res.code).toBe(1);
  });

  test("PASS round-trip with real dispatcher and full happy path", async () => {
    const target = path.join(tmpDir, "settings.json");
    const realShim = path.join(REPO_ROOT, "bin", "claude-hook");
    writeSettingsWithDispatcher(target, realShim);
    const res = await runDoctor(["--target", target, "--cwd", tmpDir]);
    const text = stripAnsi(res.stdout);
    expect(text).toContain("[PASS] bun on PATH");
    expect(text).toContain("[PASS] settings.json parses");
    expect(text).toContain("[PASS] wired hook commands resolve");
    expect(text).toContain("[PASS] state dir writable");
    expect(text).toContain("[PASS] dispatcher round-trip");
    expect(text).toContain("[INFO] last 5 ledger entries");
    expect(res.code).toBe(0);
  }, 15000);

  test("--json emits structured array of results", async () => {
    const target = path.join(tmpDir, "settings.json");
    const realShim = path.join(REPO_ROOT, "bin", "claude-hook");
    writeSettingsWithDispatcher(target, realShim);
    const res = await runDoctor([
      "--target",
      target,
      "--cwd",
      tmpDir,
      "--json",
    ]);
    const parsed = JSON.parse(res.stdout) as Array<{
      name: string;
      status: string;
    }>;
    expect(Array.isArray(parsed)).toBe(true);
    const names = parsed.map((r) => r.name);
    expect(names).toContain("bun on PATH");
    expect(names).toContain("settings.json parses");
    expect(names).toContain("dispatcher round-trip");
    expect(res.code).toBe(0);
  }, 15000);

  test("FAIL when state dir cannot be created (parent is a file)", async () => {
    const blocker = path.join(tmpDir, ".claude-hooks");
    // Create a file where the .claude-hooks directory should be
    fs.writeFileSync(blocker, "blocker", "utf8");
    const target = path.join(tmpDir, "settings.json");
    const realShim = path.join(REPO_ROOT, "bin", "claude-hook");
    writeSettingsWithDispatcher(target, realShim);
    const res = await runDoctor(["--target", target, "--cwd", tmpDir]);
    const text = stripAnsi(res.stdout);
    expect(text).toContain("[FAIL] state dir writable");
    expect(res.code).toBe(1);
  }, 15000);

  test("OTel check skipped when env var unset", async () => {
    const target = path.join(tmpDir, "settings.json");
    const realShim = path.join(REPO_ROOT, "bin", "claude-hook");
    writeSettingsWithDispatcher(target, realShim);
    const res = await runDoctor(["--target", target, "--cwd", tmpDir], {
      OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
    });
    const text = stripAnsi(res.stdout);
    expect(text).not.toContain("OTel endpoint");
    expect(res.code).toBe(0);
  }, 15000);

  test("OTel check FAILs when endpoint is unreachable", async () => {
    const target = path.join(tmpDir, "settings.json");
    const realShim = path.join(REPO_ROOT, "bin", "claude-hook");
    writeSettingsWithDispatcher(target, realShim);
    const res = await runDoctor(["--target", target, "--cwd", tmpDir], {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1/never",
    });
    const text = stripAnsi(res.stdout);
    expect(text).toContain("[FAIL] OTel endpoint");
    expect(res.code).toBe(1);
  }, 15000);

  test("INFO ledger entries when ledger.jsonl exists", async () => {
    const stateDir = path.join(tmpDir, ".claude-hooks", "state", "session-x");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "ledger.jsonl"),
      `${JSON.stringify({ event: "a" })}\n${JSON.stringify({ event: "b" })}\n`,
      "utf8",
    );
    const target = path.join(tmpDir, "settings.json");
    const realShim = path.join(REPO_ROOT, "bin", "claude-hook");
    writeSettingsWithDispatcher(target, realShim);
    const res = await runDoctor(["--target", target, "--cwd", tmpDir]);
    const text = stripAnsi(res.stdout);
    expect(text).toContain("[INFO] last 5 ledger entries");
    expect(text).toContain("1 ledgers");
    expect(text).toContain("2 entries");
    expect(res.code).toBe(0);
  }, 15000);
});
