#!/usr/bin/env bun
/**
 * Install/uninstall claude-hooks-ts hook entries into a Claude Code
 * settings.json file. Non-destructive merge: existing unrelated hooks are
 * preserved; ours are keyed by command-path prefix and replaced idempotently.
 *
 * Usage:
 *   bun run scripts/install.ts               # dry-run by default
 *   bun run scripts/install.ts --apply       # write changes atomically
 *   bun run scripts/install.ts --uninstall   # remove our entries
 *   bun run scripts/install.ts --target /path/to/settings.json
 *
 * Exit codes: 0 success, 1 error/conflict.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

const DISPATCHER_MARKERS = ["claude-hooks-ts/bin/claude-hook", "claude-hook"];
const DEFAULT_TARGET = path.join(os.homedir(), ".claude", "settings.json");

const ROUND_TRIP_PAYLOAD = JSON.stringify({
  hook_event_name: "SessionStart",
  session_id: "install-probe",
  transcript_path: "/tmp/t",
  cwd: "/tmp",
  source: "startup",
  model: "opus",
});

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

interface HookCommandEntry {
  type: "command";
  command: string;
  timeout?: number;
}

interface HookMatcher {
  matcher?: string;
  hooks: HookCommandEntry[];
}

type HookEvent = string;

interface SettingsShape {
  hooks?: Record<HookEvent, HookMatcher[]>;
  [k: string]: unknown;
}

const HOOK_EVENTS: ReadonlyArray<HookEvent> = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolBatch",
  "PostToolUseFailure",
  "Stop",
  "PreCompact",
  "SessionEnd",
  "PermissionRequest",
  "ConfigChange",
  "FileChanged",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
];

/**
 * Lazy build. `bun add -g` blocks postinstall scripts by default, so we
 * cannot rely on `scripts/build.ts` having been run at install time.
 * Instead we build on first --apply, which is when the user has already
 * committed to the install. Returns true on success.
 */
const tryBuild = (
  installRoot: string,
  out: NodeJS.WritableStream,
): boolean => {
  const buildScript = path.join(installRoot, "scripts", "build.ts");
  if (!fs.existsSync(buildScript)) return false;
  out.write(`${CYAN}build:${RESET} compiling claude-hook for ${process.platform}-${process.arch}\n`);
  const r = spawnSync("bun", ["run", buildScript], {
    cwd: installRoot,
    stdio: ["ignore", "inherit", "inherit"],
  });
  return r.status === 0;
};

/**
 * Resolve the hook command path. Prefer the compiled single-binary at
 * `<installRoot>/dist/claude-hook-<platform>-<arch>` — the bundled bun
 * runtime makes it independent of the subprocess PATH (which Claude Code
 * sanitizes). Build it lazily if missing. Fall back to the bash shim at
 * `<installRoot>/bin/claude-hook` only when --no-binary is set or the
 * build fails.
 */
const resolveDispatcherPath = (
  installRoot: string,
  noBinary: boolean,
  out: NodeJS.WritableStream = process.stdout,
): string => {
  if (noBinary) {
    return path.join(installRoot, "bin", "claude-hook");
  }
  const archMap: Record<string, string> = { x64: "x64", arm64: "arm64" };
  const arch = archMap[process.arch] ?? process.arch;
  const platform =
    process.platform === "linux"
      ? "linux"
      : process.platform === "darwin"
        ? "darwin"
        : process.platform;
  const binary = path.join(installRoot, "dist", `claude-hook-${platform}-${arch}`);
  if (!fs.existsSync(binary)) {
    tryBuild(installRoot, out);
  }
  try {
    fs.accessSync(binary, fs.constants.X_OK);
    return binary;
  } catch {
    return path.join(installRoot, "bin", "claude-hook");
  }
};

const buildEntries = (
  installRoot: string,
  noBinary: boolean = false,
  out: NodeJS.WritableStream = process.stdout,
): Record<HookEvent, HookMatcher[]> => {
  const dispatcher = resolveDispatcherPath(installRoot, noBinary, out);
  const entries: Record<HookEvent, HookMatcher[]> = {};
  for (const ev of HOOK_EVENTS) {
    entries[ev] = [
      {
        hooks: [
          {
            type: "command",
            command: `${dispatcher} ${ev}`,
            timeout: 30,
          },
        ],
      },
    ];
  }
  return entries;
};

const readJsonOr = <T>(file: string, fallback: T): T => {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const isOurEntry = (entry: HookCommandEntry): boolean =>
  DISPATCHER_MARKERS.some((m) => entry.command.includes(m));

const stripOurMatchers = (matchers: HookMatcher[]): HookMatcher[] => {
  const filtered: HookMatcher[] = [];
  for (const m of matchers) {
    const keptHooks = (m.hooks ?? []).filter((h) => !isOurEntry(h));
    if (keptHooks.length > 0) {
      filtered.push({ ...m, hooks: keptHooks });
    }
  }
  return filtered;
};

const mergeHooks = (
  existing: SettingsShape,
  ours: Record<HookEvent, HookMatcher[]>,
  mode: "install" | "uninstall",
): SettingsShape => {
  const next: SettingsShape = { ...existing };
  const hooks: Record<HookEvent, HookMatcher[]> = { ...(existing.hooks ?? {}) };
  for (const ev of HOOK_EVENTS) {
    const stripped = stripOurMatchers(hooks[ev] ?? []);
    if (mode === "install") {
      const ourMatchers = ours[ev] ?? [];
      hooks[ev] = [...stripped, ...ourMatchers];
    } else {
      if (stripped.length === 0) {
        delete hooks[ev];
      } else {
        hooks[ev] = stripped;
      }
    }
  }
  next.hooks = hooks;
  return next;
};

const colorDiff = (before: string, after: string): string => {
  const bLines = before.split("\n");
  const aLines = after.split("\n");
  const max = Math.max(bLines.length, aLines.length);
  const out: string[] = [];
  for (let i = 0; i < max; i += 1) {
    const b = bLines[i];
    const a = aLines[i];
    if (b === a) {
      if (a !== undefined) out.push(`  ${a}`);
    } else {
      if (b !== undefined) out.push(`${RED}- ${b}${RESET}`);
      if (a !== undefined) out.push(`${GREEN}+ ${a}${RESET}`);
    }
  }
  return out.join("\n");
};

interface AtomicWriteResult {
  backupPath: string | null;
}

const atomicWrite = (file: string, contents: string): AtomicWriteResult => {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  let backupPath: string | null = null;
  if (fs.existsSync(file)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = `${file}.bak.${ts}`;
    fs.copyFileSync(file, backupPath);
    process.stdout.write(`${CYAN}backup:${RESET} ${backupPath}\n`);
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, contents, "utf8");
  fs.renameSync(tmp, file);
  return { backupPath };
};

interface CliArgs {
  apply: boolean;
  uninstall: boolean;
  target: string;
  installRoot: string;
  noBinary: boolean;
}

const parseArgs = (argv: ReadonlyArray<string>): CliArgs => {
  let apply = false;
  let uninstall = false;
  let target = DEFAULT_TARGET;
  let installRoot = path.resolve(__dirname, "..");
  let noBinary = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--dry-run") apply = false;
    else if (a === "--uninstall") uninstall = true;
    else if (a === "--no-binary") noBinary = true;
    else if (a === "--target" && i + 1 < argv.length) {
      target = argv[i + 1]!;
      i += 1;
    } else if (a === "--install-root" && i + 1 < argv.length) {
      installRoot = argv[i + 1]!;
      i += 1;
    }
  }
  return { apply, uninstall, target, installRoot, noBinary };
};

interface InstallResult {
  code: number;
  applied: boolean;
  backupPath: string | null;
  target: string;
  installRoot: string;
  uninstall: boolean;
}

export const runInstallDetailed = (
  argv: ReadonlyArray<string>,
  out: NodeJS.WritableStream = process.stdout,
): InstallResult => {
  const args = parseArgs(argv);
  const existing = readJsonOr<SettingsShape>(args.target, {});
  const ours = buildEntries(args.installRoot, args.noBinary, out);
  const merged = mergeHooks(
    existing,
    ours,
    args.uninstall ? "uninstall" : "install",
  );
  const beforeStr = JSON.stringify(existing, null, 2);
  const afterStr = JSON.stringify(merged, null, 2);
  if (beforeStr === afterStr) {
    out.write(
      `${YELLOW}no changes${RESET} (target already in desired state)\n`,
    );
    return {
      code: 0,
      applied: false,
      backupPath: null,
      target: args.target,
      installRoot: args.installRoot,
      uninstall: args.uninstall,
    };
  }
  out.write(
    `${CYAN}target:${RESET} ${args.target}  ${CYAN}mode:${RESET} ${args.uninstall ? "uninstall" : "install"}  ${CYAN}apply:${RESET} ${args.apply}\n`,
  );
  out.write(colorDiff(beforeStr, afterStr) + "\n");
  let applied = false;
  let backupPath: string | null = null;
  if (args.apply) {
    try {
      const res = atomicWrite(args.target, afterStr);
      backupPath = res.backupPath;
      applied = true;
      out.write(`${GREEN}wrote:${RESET} ${args.target}\n`);
    } catch (e) {
      out.write(`${RED}error:${RESET} ${String(e)}\n`);
      return {
        code: 1,
        applied: false,
        backupPath: null,
        target: args.target,
        installRoot: args.installRoot,
        uninstall: args.uninstall,
      };
    }
  } else {
    out.write(
      `${YELLOW}dry-run:${RESET} re-run with --apply to write changes\n`,
    );
  }
  return {
    code: 0,
    applied,
    backupPath,
    target: args.target,
    installRoot: args.installRoot,
    uninstall: args.uninstall,
  };
};

export const runInstall = (
  argv: ReadonlyArray<string>,
  out: NodeJS.WritableStream = process.stdout,
): number => runInstallDetailed(argv, out).code;

interface WiredEntryLite {
  command: string;
  scriptPath: string;
}

const findDispatcherEntry = (
  settings: SettingsShape,
): WiredEntryLite | null => {
  const hooks = settings.hooks ?? {};
  for (const ev of Object.keys(hooks)) {
    const matchers = hooks[ev] ?? [];
    for (const m of matchers) {
      for (const h of m.hooks ?? []) {
        if (typeof h.command !== "string") continue;
        if (!isOurEntry(h)) continue;
        const tokens = h.command.trim().split(/\s+/);
        for (const tok of tokens) {
          if (
            tok.includes("/") &&
            (tok.includes("claude-hook") ||
              tok.endsWith(".ts") ||
              tok.endsWith(".sh"))
          ) {
            return { command: h.command, scriptPath: tok };
          }
        }
      }
    }
  }
  return null;
};

/**
 * After --apply succeeds, spawn the dispatcher with a synthetic SessionStart
 * payload to confirm the wired hook actually runs end-to-end. On failure,
 * restore the .bak.<ts> backup and return non-zero.
 */
export const verifyDispatcherRoundtrip = async (
  result: InstallResult,
  out: NodeJS.WritableStream = process.stdout,
): Promise<number> => {
  let settings: SettingsShape;
  try {
    const raw = fs.readFileSync(result.target, "utf8");
    settings = JSON.parse(raw) as SettingsShape;
  } catch (e) {
    out.write(
      `${RED}✗ Round-trip failed; settings rolled back${RESET} (read-back: ${String(e)})\n`,
    );
    rollback(result, out);
    return 1;
  }
  const entry = findDispatcherEntry(settings);
  if (!entry) {
    out.write(
      `${RED}✗ Round-trip failed; settings rolled back${RESET} (no dispatcher entry found post-write)\n`,
    );
    rollback(result, out);
    return 1;
  }
  if (!fs.existsSync(entry.scriptPath)) {
    out.write(
      `${RED}✗ Round-trip failed; settings rolled back${RESET} (dispatcher script missing: ${entry.scriptPath})\n`,
    );
    rollback(result, out);
    return 1;
  }
  const tokens = entry.command.trim().split(/\s+/);
  const argv: string[] = [];
  let scriptIdx = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === entry.scriptPath) {
      scriptIdx = i;
      break;
    }
  }
  if (scriptIdx === -1) {
    argv.push("bun", "run", entry.scriptPath, "SessionStart");
  } else {
    for (let i = 0; i <= scriptIdx; i += 1) argv.push(tokens[i]!);
    argv.push("SessionStart");
  }
  if (!argv[0]!.includes("bun")) {
    try {
      fs.accessSync(argv[0]!, fs.constants.X_OK);
    } catch {
      argv.unshift("bash");
    }
  }
  try {
    const proc = Bun.spawn(argv, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(ROUND_TRIP_PAYLOAD);
    await proc.stdin.end();
    const timeoutMs = 5000;
    const winner = await Promise.race([
      proc.exited,
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), timeoutMs),
      ),
    ]);
    if (winner === "timeout") {
      try {
        proc.kill();
      } catch {
        // ignore
      }
      out.write(
        `${RED}✗ Round-trip failed; settings rolled back${RESET} (5s timeout)\n`,
      );
      rollback(result, out);
      return 1;
    }
    const code = proc.exitCode ?? -1;
    const stdout = await new Response(proc.stdout).text();
    if (code !== 0) {
      out.write(
        `${RED}✗ Round-trip failed; settings rolled back${RESET} (exit ${code}; stdout=${stdout.slice(0, 200)})\n`,
      );
      rollback(result, out);
      return 1;
    }
    try {
      JSON.parse(stdout);
    } catch (e) {
      out.write(
        `${RED}✗ Round-trip failed; settings rolled back${RESET} (stdout not JSON: ${String(e)})\n`,
      );
      rollback(result, out);
      return 1;
    }
    out.write(`${GREEN}✓ Dispatcher round-trip verified${RESET}\n`);
    return 0;
  } catch (e) {
    out.write(
      `${RED}✗ Round-trip failed; settings rolled back${RESET} (spawn: ${String(e)})\n`,
    );
    rollback(result, out);
    return 1;
  }
};

const rollback = (result: InstallResult, out: NodeJS.WritableStream): void => {
  if (result.backupPath !== null && fs.existsSync(result.backupPath)) {
    try {
      fs.copyFileSync(result.backupPath, result.target);
    } catch (e) {
      out.write(`${RED}rollback error:${RESET} ${String(e)}\n`);
    }
  } else if (result.backupPath === null) {
    // No prior file existed; remove the file we just wrote.
    try {
      fs.unlinkSync(result.target);
    } catch {
      // ignore
    }
  }
};

if (import.meta.main) {
  const bunPath = await Bun.which("bun");
  if (!bunPath) {
    process.stderr.write(
      "claude-hooks-install: bun is required but not on PATH.\n" +
        "Install: curl -fsSL https://bun.sh/install | bash\n",
    );
    process.exit(1);
  }
  const result = runInstallDetailed(process.argv.slice(2));
  if (result.code !== 0) {
    process.exit(result.code);
  }
  if (result.applied && !result.uninstall) {
    const verifyCode = await verifyDispatcherRoundtrip(result);
    process.exit(verifyCode);
  }
  process.exit(result.code);
}
