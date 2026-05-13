import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Cause, Effect, Exit } from "effect";
import { withFileLock } from "../../src/services/file-lock.ts";
import { FileSystem, FileSystemLive } from "../../src/services/filesystem.ts";

const tmpFile = (name: string): string =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-lock-")), name);

describe("withFileLock parallel JSONL writes", () => {
  test("10 concurrent writers x 50 entries: no corruption, correct count, all writers represented", async () => {
    const file = tmpFile("ledger.jsonl");
    const WRITERS = 10;
    const PER_WRITER = 50;
    const writerIds = Array.from({ length: WRITERS }, (_, i) => `writer-${i}`);

    await Promise.all(
      writerIds.map(async (wid) => {
        for (let i = 0; i < PER_WRITER; i++) {
          await withFileLock(file, async () => {
            const line = JSON.stringify({ wid, seq: i }) + "\n";
            await fsp.appendFile(file, line, "utf8");
          });
        }
      }),
    );

    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);

    // No malformed lines — every line parses as JSON with wid + seq.
    const seenWriters = new Set<string>();
    for (const line of lines) {
      const parsed = JSON.parse(line) as { wid: unknown; seq: unknown };
      expect(typeof parsed.wid).toBe("string");
      expect(typeof parsed.seq).toBe("number");
      seenWriters.add(parsed.wid as string);
    }

    expect(lines.length).toBe(WRITERS * PER_WRITER);
    // Every writer must show up — proves concurrency was real, not serialized.
    expect(seenWriters.size).toBe(WRITERS);
    for (const wid of writerIds) {
      expect(seenWriters.has(wid)).toBe(true);
    }

    // Lock sentinel must be cleaned up.
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  }, 30_000);

  test("stale lock (older than staleMs) is force-removed and acquired", async () => {
    const file = tmpFile("stale.jsonl");
    const lockPath = `${file}.lock`;
    // Plant a stale lock with mtime well in the past.
    fs.writeFileSync(lockPath, "99999");
    const past = (Date.now() - 60_000) / 1000;
    fs.utimesSync(lockPath, past, past);

    let ran = false;
    await withFileLock(
      file,
      async () => {
        ran = true;
        await fsp.writeFile(file, "ok\n", "utf8");
      },
      { staleMs: 1_000, timeoutMs: 2_000 },
    );

    expect(ran).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("ok\n");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("contention beyond timeout throws", async () => {
    const file = tmpFile("timeout.jsonl");
    const lockPath = `${file}.lock`;
    // Hold lock manually with fresh mtime — never stale within test window.
    fs.writeFileSync(lockPath, String(process.pid));
    try {
      await expect(
        withFileLock(file, async () => undefined, {
          staleMs: 60_000,
          timeoutMs: 200,
        }),
      ).rejects.toThrow(/timeout/i);
    } finally {
      fs.unlinkSync(lockPath);
    }
  });

  test("old lock owned by a live process is not treated as stale", async () => {
    const file = tmpFile("live-owner.jsonl");
    const lockPath = `${file}.lock`;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() - 60_000 }));
    const past = (Date.now() - 60_000) / 1000;
    fs.utimesSync(lockPath, past, past);
    try {
      await expect(
        withFileLock(file, async () => undefined, {
          staleMs: 1_000,
          timeoutMs: 200,
        }),
      ).rejects.toThrow(/timeout/i);
      expect(fs.existsSync(lockPath)).toBe(true);
    } finally {
      fs.unlinkSync(lockPath);
    }
  });

  test("callback failure is not retried as lock contention", async () => {
    const file = tmpFile("body-error.jsonl");
    let attempts = 0;

    await expect(
      withFileLock(file, async () => {
        attempts += 1;
        throw new Error("body failed");
      }),
    ).rejects.toThrow("body failed");

    expect(attempts).toBe(1);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  test("FileSystemLive.withLock preserves body failures", async () => {
    const file = tmpFile("fs-body-error.jsonl");
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const fsApi = yield* FileSystem;
        yield* fsApi.withLock(file, Effect.fail("body-failure"));
      }).pipe(Effect.provide(FileSystemLive)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") expect(failure.value).toBe("body-failure");
    }
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });
});
