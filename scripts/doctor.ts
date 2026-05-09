#!/usr/bin/env bun
/**
 * claude-hooks-doctor — diagnostic CLI for claude-hooks-ts installs.
 *
 * Verifies bun is on PATH, the target settings.json parses, every wired hook
 * command resolves to an executable file, the per-project state dir is
 * writable, the dispatcher round-trips a synthetic SessionStart payload, and
 * (optionally) an OTel endpoint is reachable. Prints PASS/FAIL/INFO lines and
 * exits non-zero on any FAIL.
 *
 * Usage:
 *   claude-hooks-doctor [--target <settings.json>] [--cwd <path>] [--verbose] [--json]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

interface CliArgs {
  target: string;
  cwd: string;
  verbose: boolean;
  json: boolean;
}

type Status = "PASS" | "FAIL" | "INFO";

interface CheckResult {
  name: string;
  status: Status;
  detail?: string;
}

interface HookCommandEntry {
  type?: string;
  command: string;
  timeout?: number;
}

interface HookMatcher {
  matcher?: string;
  hooks?: HookCommandEntry[];
}

interface SettingsShape {
  hooks?: Record<string, HookMatcher[]>;
  [k: string]: unknown;
}

const DEFAULT_TARGET = path.join(os.homedir(), ".claude", "settings.json");

const SYNTHETIC_PAYLOAD = JSON.stringify({
  hook_event_name: "SessionStart",
  session_id: "doctor-probe",
  transcript_path: "/tmp/t",
  cwd: "/tmp",
  source: "startup",
  model: "opus",
});

const parseArgs = (argv: ReadonlyArray<string>): CliArgs => {
  let target = DEFAULT_TARGET;
  let cwd = process.cwd();
  let verbose = false;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--target" && i + 1 < argv.length) {
      target = argv[i + 1]!;
      i += 1;
    } else if (a === "--cwd" && i + 1 < argv.length) {
      cwd = argv[i + 1]!;
      i += 1;
    } else if (a === "--verbose") {
      verbose = true;
    } else if (a === "--json") {
      json = true;
    }
  }
  return { target, cwd, verbose, json };
};

const isOurDispatcherCmd = (cmd: string): boolean =>
  cmd.includes("claude-hook") || cmd.includes("dispatcher.ts");

/**
 * Extract the underlying script path from a wired hook command string.
 * Handles raw `/path/to/bin/claude-hook ARG`, `bun run /path/to/dispatcher.ts ARG`,
 * and similar shapes. Returns null if no path-like token is found.
 */
const extractScriptPath = (cmd: string): string | null => {
  const tokens = cmd.trim().split(/\s+/);
  for (const tok of tokens) {
    if (
      tok.includes("/") &&
      (tok.includes("claude-hook") ||
        tok.endsWith(".ts") ||
        tok.endsWith(".sh"))
    ) {
      return tok;
    }
  }
  return null;
};

const isExecutable = (p: string): boolean => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const checkBun = async (): Promise<CheckResult> => {
  const found = Bun.which("bun");
  if (!found) {
    return {
      name: "bun on PATH",
      status: "FAIL",
      detail: "Bun.which('bun') returned null",
    };
  }
  return { name: "bun on PATH", status: "PASS", detail: found };
};

const checkSettingsParse = (
  target: string,
): { result: CheckResult; settings: SettingsShape | null } => {
  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch (e) {
    return {
      result: {
        name: "settings.json parses",
        status: "FAIL",
        detail: `read error: ${String(e)}`,
      },
      settings: null,
    };
  }
  try {
    const parsed = JSON.parse(raw) as SettingsShape;
    return {
      result: { name: "settings.json parses", status: "PASS", detail: target },
      settings: parsed,
    };
  } catch (e) {
    return {
      result: {
        name: "settings.json parses",
        status: "FAIL",
        detail: `parse error: ${String(e)}`,
      },
      settings: null,
    };
  }
};

interface WiredEntry {
  event: string;
  command: string;
  scriptPath: string;
}

const collectWiredEntries = (settings: SettingsShape): WiredEntry[] => {
  const out: WiredEntry[] = [];
  const hooks = settings.hooks ?? {};
  for (const ev of Object.keys(hooks)) {
    const matchers = hooks[ev] ?? [];
    for (const m of matchers) {
      for (const h of m.hooks ?? []) {
        if (typeof h.command !== "string") continue;
        if (!isOurDispatcherCmd(h.command)) continue;
        const scriptPath = extractScriptPath(h.command);
        if (scriptPath !== null) {
          out.push({ event: ev, command: h.command, scriptPath });
        }
      }
    }
  }
  return out;
};

const checkWiredCommands = (entries: WiredEntry[]): CheckResult => {
  if (entries.length === 0) {
    return {
      name: "wired hook commands resolve",
      status: "FAIL",
      detail: "no claude-hooks-ts entries found in settings.json",
    };
  }
  const broken: string[] = [];
  for (const e of entries) {
    if (!fs.existsSync(e.scriptPath)) {
      broken.push(`${e.event}: ${e.scriptPath} (missing)`);
      continue;
    }
    if (!isExecutable(e.scriptPath)) {
      // .ts files are run through bun, only require existence; for shim scripts require +x
      if (e.scriptPath.endsWith(".ts")) {
        continue;
      }
      broken.push(`${e.event}: ${e.scriptPath} (not executable)`);
    }
  }
  if (broken.length > 0) {
    return {
      name: "wired hook commands resolve",
      status: "FAIL",
      detail: broken.join("; "),
    };
  }
  return {
    name: "wired hook commands resolve",
    status: "PASS",
    detail: `${entries.length} entries`,
  };
};

const checkStateDirWritable = (cwd: string): CheckResult => {
  const dir = path.join(cwd, ".claude-hooks", "state");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.doctor-probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, "ok", "utf8");
    fs.unlinkSync(probe);
    return { name: "state dir writable", status: "PASS", detail: dir };
  } catch (e) {
    return {
      name: "state dir writable",
      status: "FAIL",
      detail: `${dir}: ${String(e)}`,
    };
  }
};

const checkDispatcherRoundtrip = async (
  entries: WiredEntry[],
): Promise<CheckResult> => {
  const target = entries.find((e) => fs.existsSync(e.scriptPath));
  if (!target) {
    return {
      name: "dispatcher round-trip",
      status: "FAIL",
      detail: "no resolvable dispatcher entry",
    };
  }
  // Build argv: if command is `bun run <path> ARG ...` use that, else `<path> ARG ...`
  const tokens = target.command.trim().split(/\s+/);
  // Replace event arg with SessionStart
  const argv: string[] = [];
  let scriptIdx = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === target.scriptPath) {
      scriptIdx = i;
      break;
    }
  }
  if (scriptIdx === -1) {
    // fall back: bun run scriptPath SessionStart
    argv.push("bun", "run", target.scriptPath, "SessionStart");
  } else {
    for (let i = 0; i <= scriptIdx; i += 1) argv.push(tokens[i]!);
    argv.push("SessionStart");
  }
  // If the command was a bash shim (claude-hook) and the file isn't executable, prepend bash.
  // The shim is `#!/usr/bin/env bash` — relies on +x. If +x is missing, run via bash explicitly.
  if (!argv[0]!.includes("bun") && !isExecutable(argv[0]!)) {
    argv.unshift("bash");
  }
  try {
    const proc = Bun.spawn(argv, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(SYNTHETIC_PAYLOAD);
    await proc.stdin.end();
    const timeoutMs = 5000;
    const exitPromise = proc.exited;
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), timeoutMs),
    );
    const winner = await Promise.race([exitPromise, timeout]);
    if (winner === "timeout") {
      try {
        proc.kill();
      } catch {
        // ignore
      }
      return {
        name: "dispatcher round-trip",
        status: "FAIL",
        detail: "5s timeout",
      };
    }
    const code = proc.exitCode ?? -1;
    const stdout = await new Response(proc.stdout).text();
    if (code !== 0) {
      return {
        name: "dispatcher round-trip",
        status: "FAIL",
        detail: `exit ${code}; stdout=${stdout.slice(0, 200)}`,
      };
    }
    try {
      JSON.parse(stdout);
    } catch (e) {
      return {
        name: "dispatcher round-trip",
        status: "FAIL",
        detail: `stdout not JSON: ${String(e)}; stdout=${stdout.slice(0, 200)}`,
      };
    }
    return {
      name: "dispatcher round-trip",
      status: "PASS",
      detail: `exit 0, ${stdout.length}B`,
    };
  } catch (e) {
    return { name: "dispatcher round-trip", status: "FAIL", detail: String(e) };
  }
};

const checkLedgerEntries = (cwd: string): CheckResult => {
  const stateDir = path.join(cwd, ".claude-hooks", "state");
  if (!fs.existsSync(stateDir)) {
    return {
      name: "last 5 ledger entries",
      status: "INFO",
      detail: "no state dir",
    };
  }
  const found: string[] = [];
  const walk = (dir: string): void => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
      } else if (ent.isFile() && ent.name === "ledger.jsonl") {
        found.push(p);
      }
    }
  };
  walk(stateDir);
  if (found.length === 0) {
    return {
      name: "last 5 ledger entries",
      status: "INFO",
      detail:
        "no ledger.jsonl yet — expected on a fresh install; populates after the first session",
    };
  }
  const lines: string[] = [];
  for (const f of found) {
    try {
      const raw = fs.readFileSync(f, "utf8").trim();
      if (raw.length === 0) continue;
      const fileLines = raw.split("\n");
      for (const l of fileLines) lines.push(l);
    } catch {
      // skip
    }
  }
  const tail = lines.slice(-5);
  return {
    name: "last 5 ledger entries",
    status: "INFO",
    detail: `${found.length} ledgers, ${lines.length} entries; tail:\n${tail.join("\n")}`,
  };
};

const checkOtelEndpoint = async (): Promise<CheckResult | null> => {
  const ep = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  if (!ep || ep.length === 0) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1000);
    const res = await fetch(ep, { method: "HEAD", signal: ctrl.signal });
    clearTimeout(timer);
    if (res.status >= 200 && res.status < 300) {
      return {
        name: "OTel endpoint",
        status: "PASS",
        detail: `${ep} -> ${res.status}`,
      };
    }
    return {
      name: "OTel endpoint",
      status: "FAIL",
      detail: `${ep} -> ${res.status}`,
    };
  } catch (e) {
    return {
      name: "OTel endpoint",
      status: "FAIL",
      detail: `${ep}: ${String(e)}`,
    };
  }
};

const formatHuman = (results: CheckResult[]): string => {
  const lines: string[] = [];
  for (const r of results) {
    const tag = `[${r.status}]`;
    if (r.detail !== undefined && r.detail.length > 0) {
      lines.push(`${tag} ${r.name}: ${r.detail}`);
    } else {
      lines.push(`${tag} ${r.name}`);
    }
  }
  return lines.join("\n") + "\n";
};

/**
 * Classifier env check — is `claude` on PATH AND is the disable-bypass not set?
 * The classifier is the gate that promotes prompts to ALGORITHM mode; if
 * `claude` isn't installed OR the bypass env var is on, the package quietly
 * runs in fail-safe (everything → ALGORITHM E3) without ever invoking
 * Sonnet. That's safe but undermines the design.
 */
const checkClassifierEnv = (): CheckResult => {
  const claudeBin = Bun.which("claude");
  const bypass =
    process.env["CLAUDE_HOOKS_DISABLE_CLASSIFIER"] === "1" ||
    process.env["CLAUDE_HOOKS_DISABLE_CLASSIFIER"] === "true";
  if (claudeBin === null) {
    return {
      name: "classifier subprocess available",
      status: "INFO",
      detail:
        "`claude` not on PATH — classifier will fail-safe to ALGORITHM E3 every prompt. Install Claude Code to enable proper mode classification.",
    };
  }
  if (bypass) {
    return {
      name: "classifier subprocess available",
      status: "INFO",
      detail:
        "CLAUDE_HOOKS_DISABLE_CLASSIFIER=1 — classifier subprocess is bypassed; every prompt becomes fail-safe ALGORITHM E3. Unset to re-enable.",
    };
  }
  return {
    name: "classifier subprocess available",
    status: "PASS",
    detail: `claude=${claudeBin}, bypass=off`,
  };
};

/**
 * Classifier auth check — which credential will the subprocess actually use?
 * The chokepoint scrubs ANTHROPIC_API_KEY/AUTH_TOKEN from the spawn env,
 * but we want to surface to the user that subscription billing is in play.
 * Loud warning when API keys are present in env (their work won't be billed
 * as expected even though we scrub — they may be mis-configuring elsewhere).
 */
const checkClassifierAuth = (): CheckResult => {
  const hasApiKey = typeof process.env["ANTHROPIC_API_KEY"] === "string";
  const hasAuthToken = typeof process.env["ANTHROPIC_AUTH_TOKEN"] === "string";
  const hasOauthToken = typeof process.env["CLAUDE_CODE_OAUTH_TOKEN"] === "string";
  if (hasApiKey || hasAuthToken) {
    return {
      name: "classifier billing path",
      status: "INFO",
      detail: `ANTHROPIC_${hasApiKey ? "API_KEY" : "AUTH_TOKEN"} is set in env. The chokepoint scrubs it before spawn so classifier work routes through OAuth/keychain, but other tools you spawn manually will still pick it up.`,
    };
  }
  if (hasOauthToken) {
    return {
      name: "classifier billing path",
      status: "PASS",
      detail: "CLAUDE_CODE_OAUTH_TOKEN present — subscription billing.",
    };
  }
  return {
    name: "classifier billing path",
    status: "INFO",
    detail:
      "No CLAUDE_CODE_OAUTH_TOKEN, no ANTHROPIC_API_KEY/AUTH_TOKEN — classifier will use whatever credential the `claude` CLI's keychain login provides.",
  };
};

/**
 * Skill bundle check — count algorithm_capability: thinking SKILL.md files
 * in ~/.claude/skills/<Name>/ AND ~/.claude/skills/_bundled/<Name>/ so the
 * user can see the phantom-audit substrate.
 */
const checkSkillBundle = (): CheckResult => {
  const home = os.homedir();
  const roots = [
    path.join(home, ".claude", "skills"),
    path.join(home, ".claude", "skills", "_bundled"),
  ];
  let count = 0;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let entries: ReadonlyArray<string> = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const skillFile = path.join(root, name, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      try {
        const body = fs.readFileSync(skillFile, "utf-8");
        if (/^algorithm_capability:\s*thinking\s*$/m.test(body)) count += 1;
      } catch {
        // best-effort
      }
    }
  }
  return {
    name: "thinking-capability skill stubs installed",
    status: count > 0 ? "PASS" : "INFO",
    detail:
      count > 0
        ? `${count} skill(s) declare algorithm_capability: thinking under ~/.claude/skills/`
        : "no skill declares algorithm_capability: thinking — phantom audit gate has nothing to enforce against. Run `claude-hooks-init --install-skills` to install the bundled stubs.",
  };
};

/**
 * Active ISA check — is there a project ISA at cwd or a latest task ISA in
 * .claude-hooks/state/work/? Reports phase + progress so the user can see at
 * a glance what state the work is in.
 */
const checkActiveIsa = (cwd: string): CheckResult => {
  const projectIsa = path.join(cwd, "ISA.md");
  const taskIsaDir = path.join(cwd, ".claude-hooks", "state", "work");
  const candidates: string[] = [];
  if (fs.existsSync(projectIsa)) candidates.push(projectIsa);
  if (fs.existsSync(taskIsaDir)) {
    let entries: ReadonlyArray<string> = [];
    try {
      entries = fs.readdirSync(taskIsaDir);
    } catch {
      // fall through
    }
    for (const slug of entries) {
      const isa = path.join(taskIsaDir, slug, "ISA.md");
      if (fs.existsSync(isa)) candidates.push(isa);
    }
  }
  if (candidates.length === 0) {
    return {
      name: "active ISA",
      status: "INFO",
      detail: "no ISA at <cwd>/ISA.md or .claude-hooks/state/work/<slug>/ISA.md — Algorithm gates noop.",
    };
  }
  // Report the FIRST one (project preferred, then any task ISA).
  const path0 = candidates[0]!;
  let body = "";
  try {
    body = fs.readFileSync(path0, "utf-8");
  } catch {
    return {
      name: "active ISA",
      status: "INFO",
      detail: `found ${path0} but couldn't read it`,
    };
  }
  const phaseMatch = body.match(/^phase:\s*(.+)$/m);
  const progressMatch = body.match(/^progress:\s*(.+)$/m);
  const phase = phaseMatch?.[1]?.trim() ?? "(unknown)";
  const progress = progressMatch?.[1]?.trim() ?? "(unknown)";
  return {
    name: "active ISA",
    status: "PASS",
    detail: `${path0} | phase=${phase} | progress=${progress}${candidates.length > 1 ? ` | (+${candidates.length - 1} more)` : ""}`,
  };
};

export const runDoctor = async (
  argv: ReadonlyArray<string>,
  out: NodeJS.WritableStream = process.stdout,
): Promise<number> => {
  const args = parseArgs(argv);
  const results: CheckResult[] = [];

  results.push(await checkBun());

  const { result: parseResult, settings } = checkSettingsParse(args.target);
  results.push(parseResult);

  let entries: WiredEntry[] = [];
  if (settings !== null) {
    entries = collectWiredEntries(settings);
    results.push(checkWiredCommands(entries));
  } else {
    results.push({
      name: "wired hook commands resolve",
      status: "FAIL",
      detail: "settings unparseable",
    });
  }

  results.push(checkStateDirWritable(args.cwd));

  if (entries.length > 0) {
    results.push(await checkDispatcherRoundtrip(entries));
  } else {
    results.push({
      name: "dispatcher round-trip",
      status: "FAIL",
      detail: "no wired entries to probe",
    });
  }

  results.push(checkLedgerEntries(args.cwd));

  // Algorithm-aware checks (Phase 5).
  results.push(checkClassifierEnv());
  results.push(checkClassifierAuth());
  results.push(checkSkillBundle());
  results.push(checkActiveIsa(args.cwd));

  const otel = await checkOtelEndpoint();
  if (otel !== null) results.push(otel);

  if (args.json) {
    out.write(JSON.stringify(results, null, 2) + "\n");
  } else {
    out.write(formatHuman(results));
  }

  const failed = results.some((r) => r.status === "FAIL");
  return failed ? 1 : 0;
};

if (import.meta.main) {
  const code = await runDoctor(process.argv.slice(2));
  process.exit(code);
}
