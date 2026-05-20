import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "confirm-methodology.sh");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const runScript = async (
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
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code: proc.exitCode ?? -1, stdout, stderr };
};

describe("confirm-methodology.sh", () => {
  test("script exists and is executable", () => {
    expect(fs.existsSync(SCRIPT)).toBe(true);
    const mode = fs.statSync(SCRIPT).mode;
    // owner-executable bit set
    expect(mode & 0o100).toBe(0o100);
  });

  test("--help exits 0 and prints usage", async () => {
    const result = await runScript(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("usage");
  });

  test("-h exits 0 and prints usage", async () => {
    const result = await runScript(["-h"]);
    expect(result.code).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("usage");
  });

  test("DRY_RUN=1 short-circuits and prints the green summary", async () => {
    const result = await runScript([], { CONFIRM_METHODOLOGY_DRY_RUN: "1" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("✓ Methodology enforced end-to-end");
  });

  test("rejects unknown flags with non-zero exit", async () => {
    const result = await runScript(["--no-such-flag"], {
      CONFIRM_METHODOLOGY_DRY_RUN: "1",
    });
    expect(result.code).not.toBe(0);
  });
});
