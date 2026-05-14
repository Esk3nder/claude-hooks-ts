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
import { Option, Redacted } from "effect";
import { currentProcessEnv, type EnvMap } from "../src/bootstrap/env.ts";
import {
  runtimeConfigFromEnv,
  summarizeRuntimeConfig,
  type RuntimeConfig,
} from "../src/services/runtime-config.ts";
import { loadProbes, parseTestStrategy } from "../src/algorithm/isa/probes.ts";
import { parseSections } from "../src/algorithm/isa/sections.ts";
import { splitShellWords } from "../src/services/shell-words.ts";
import {
  parseVerifyMapYaml,
  verifyMapPathFor,
} from "../src/policies/verify-map.ts";
import { runCommandLive } from "../src/services/command-runner.ts";

interface CliArgs {
  target: string;
  cwd: string;
  verbose: boolean;
  json: boolean;
}

type Status = "PASS" | "FAIL" | "WARN" | "INFO";

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

const LEDGER_TAIL_MAX_BYTES = 64 * 1024;

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
  const tokens = splitShellWords(cmd);
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
      // Include the raw command so cross-version skew (parser-out-of-sync-with-writer)
      // is obvious from one line of output instead of indistinguishable from a missing file.
      broken.push(`${e.event}: ${e.scriptPath} (missing) [raw command: ${e.command}]`);
      continue;
    }
    if (!isExecutable(e.scriptPath)) {
      // .ts files are run through bun, only require existence; for shim scripts require +x
      if (e.scriptPath.endsWith(".ts")) {
        continue;
      }
      broken.push(`${e.event}: ${e.scriptPath} (not executable) [raw command: ${e.command}]`);
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
  const tokens = splitShellWords(target.command);
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
    const timeoutMs = 5000;
    const run = await runCommandLive(argv[0]!, argv.slice(1), {
      stdin: SYNTHETIC_PAYLOAD,
      timeoutMs,
    });
    if (run.timedOut) {
      return {
        name: "dispatcher round-trip",
        status: "FAIL",
        detail: "5s timeout",
      };
    }
    const code = run.exitCode;
    const stdout = run.stdout;
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
      lines.push(...readLedgerTailLines(f));
    } catch {
      // skip
    }
  }
  const tail = lines.slice(-5);
  return {
    name: "last 5 ledger entries",
    status: "INFO",
    detail: `${found.length} ledgers, ${lines.length} entries sampled; tail:\n${tail.join("\n")}`,
  };
};

const readLedgerTailLines = (file: string): string[] => {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size <= 0) return [];
  const length = Math.min(stat.size, LEDGER_TAIL_MAX_BYTES);
  const start = Math.max(0, stat.size - length);
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    let raw = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const previous = Buffer.alloc(1);
      const previousBytes = fs.readSync(fd, previous, 0, 1, start - 1);
      const startsOnLineBoundary = previousBytes === 1 && (previous[0] === 0x0a || previous[0] === 0x0d);
      if (!startsOnLineBoundary) {
        const firstLineEnd = raw.indexOf("\n");
        raw = firstLineEnd >= 0 ? raw.slice(firstLineEnd + 1) : "";
      }
    }
    return raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  } finally {
    fs.closeSync(fd);
  }
};

const displayEndpoint = (endpoint: string): string => {
  try {
    const url = new URL(endpoint);
    const pathName = url.pathname.replace(/[A-Za-z0-9._~-]{16,}/g, "[redacted]");
    return `${url.protocol}//${url.host}${pathName === "/" ? "" : pathName}`;
  } catch {
    return "[configured endpoint]";
  }
};

const displayEndpointError = (cause: unknown): string => {
  if (cause instanceof Error) {
    return cause.name;
  }
  return "request failed";
};

const checkOtelEndpoint = async (
  config: RuntimeConfig,
): Promise<CheckResult | null> => {
  if (Option.isNone(config.otelEndpoint)) return null;
  const ep = Redacted.value(config.otelEndpoint.value);
  const shown = displayEndpoint(ep);
  try {
    const res = await fetch(ep, {
      method: "HEAD",
      signal: AbortSignal.timeout(1000),
    });
    if (res.status >= 200 && res.status < 300) {
      return {
        name: "OTel endpoint",
        status: "PASS",
        detail: `${shown} -> ${res.status}`,
      };
    }
    return {
      name: "OTel endpoint",
      status: "FAIL",
      detail: `${shown} -> ${res.status}`,
    };
  } catch (e) {
    return {
      name: "OTel endpoint",
      status: "FAIL",
      detail: `${shown}: ${displayEndpointError(e)}`,
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
const checkClassifierEnv = (config: RuntimeConfig): CheckResult => {
  const claudeBin = Bun.which("claude");
  const bypass = config.classifierDisabled;
  // Bypass is reported FIRST — it's the most actionable signal regardless
  // of whether `claude` is installed: even with a working `claude` on PATH,
  // the bypass env var would prevent the subprocess from being invoked. So
  // surface that to the user first; if they unset it, the next doctor run
  // will fall through to the PATH check.
  //
  // (Pre-fix order had the PATH check first, which made the bypass branch
  // unreachable in CI environments where `claude` isn't installed — the
  // doctor's CI test for the bypass message then failed.)
  if (bypass) {
    return {
      name: "classifier subprocess available",
      status: "INFO",
      detail:
        "CLAUDE_HOOKS_DISABLE_CLASSIFIER=1 — classifier subprocess is bypassed; every prompt becomes fail-safe ALGORITHM E3. Unset to re-enable.",
    };
  }
  if (claudeBin === null) {
    return {
      name: "classifier subprocess available",
      status: "INFO",
      detail:
        "`claude` not on PATH — classifier will fail-safe to ALGORITHM E3 every prompt. Install Claude Code to enable proper mode classification.",
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
const checkClassifierAuth = (env: EnvMap): CheckResult => {
  const hasApiKey = typeof env["ANTHROPIC_API_KEY"] === "string";
  const hasAuthToken = typeof env["ANTHROPIC_AUTH_TOKEN"] === "string";
  const hasOauthToken = typeof env["CLAUDE_CODE_OAUTH_TOKEN"] === "string";
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
 * .claude-hooks/work/ (canonical) or .claude-hooks/state/work/ (legacy)?
 * Reports phase + progress so the user can see at a glance what state the
 * work is in.
 */
const checkActiveIsa = (cwd: string): CheckResult => {
  const projectIsa = path.join(cwd, "ISA.md");
  const taskIsaDirs = [
    path.join(cwd, ".claude-hooks", "work"),
    path.join(cwd, ".claude-hooks", "state", "work"),
  ];
  const candidates: string[] = [];
  if (fs.existsSync(projectIsa)) candidates.push(projectIsa);
  for (const taskIsaDir of taskIsaDirs) {
    if (!fs.existsSync(taskIsaDir)) continue;
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
      detail: "no ISA at <cwd>/ISA.md or .claude-hooks/work/<slug>/ISA.md — Algorithm gates noop.",
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

/**
 * Probe registry vs. ISA tool-column check.
 *
 * Common misconfiguration: a user looks at an ISA's Test Strategy table —
 * `| ISC-1 | bun | smoke | n/a | tests-pass |` — and writes
 * `probes = { "ISC-1": ... }` because the row's leading id reads as the
 * obvious key. The runtime registry is keyed by the *tool* column
 * (`"tests-pass"`), so the probe never matches and ISCs never auto-flip.
 * This check surfaces the mismatch loudly and points the user at the right
 * key, including a footgun-specific hint when an orphan key looks like an
 * ISC id.
 *
 * Returns null when probes.ts is absent (opt-in; nothing to validate).
 */
const collectIsaPaths = (cwd: string): string[] => {
  const out: string[] = [];
  const projectIsa = path.join(cwd, "ISA.md");
  if (fs.existsSync(projectIsa)) out.push(projectIsa);
  const taskIsaDirs = [
    path.join(cwd, ".claude-hooks", "work"),
    path.join(cwd, ".claude-hooks", "state", "work"),
  ];
  for (const taskIsaDir of taskIsaDirs) {
    if (!fs.existsSync(taskIsaDir)) continue;
    let entries: ReadonlyArray<string> = [];
    try {
      entries = fs.readdirSync(taskIsaDir);
    } catch {
      continue;
    }
    for (const slug of entries) {
      const isa = path.join(taskIsaDir, slug, "ISA.md");
      if (fs.existsSync(isa)) out.push(isa);
    }
  }
  return out;
};

/**
 * Legacy ISA migration check (Option B follow-up). Returns null when there
 * is no migration signal worth reporting:
 *   - No legacy `state/work/` dir at all (fresh install or never used) → null
 *   - Legacy dir exists AND canonical dir also has slugs → null (assume the
 *     canonical install is the active one and the legacy is residue)
 *
 * Returns a WARN when slugs exist ONLY in legacy and not in canonical:
 * those task ISAs are gitignored (since they live under `.claude-hooks/state/`)
 * and would be lost on the next `git clean -fdx`. The detail string includes
 * the one-liner needed to migrate.
 */
const checkLegacyIsaMigration = (cwd: string): CheckResult | null => {
  const legacyDir = path.join(cwd, ".claude-hooks", "state", "work");
  const canonicalDir = path.join(cwd, ".claude-hooks", "work");
  if (!fs.existsSync(legacyDir)) return null;
  let legacySlugs: ReadonlyArray<string> = [];
  try {
    legacySlugs = fs.readdirSync(legacyDir).filter((slug) =>
      fs.existsSync(path.join(legacyDir, slug, "ISA.md")),
    );
  } catch {
    return null;
  }
  if (legacySlugs.length === 0) return null;
  let canonicalSlugs: ReadonlyArray<string> = [];
  if (fs.existsSync(canonicalDir)) {
    try {
      canonicalSlugs = fs.readdirSync(canonicalDir).filter((slug) =>
        fs.existsSync(path.join(canonicalDir, slug, "ISA.md")),
      );
    } catch {
      // fall through — treat as empty
    }
  }
  if (canonicalSlugs.length > 0) return null;
  // Only legacy has ISAs → user is on the old layout. Nudge to migrate.
  const preview = legacySlugs.slice(0, 3).join(", ");
  const more = legacySlugs.length > 3 ? `, +${legacySlugs.length - 3} more` : "";
  return {
    name: "ISA storage location",
    status: "WARN",
    detail:
      `${legacySlugs.length} task ISA(s) found ONLY under the legacy gitignored path ` +
      `.claude-hooks/state/work/ ([${preview}${more}]). Migrate to the tracked location ` +
      `with: \`mkdir -p .claude-hooks/work && mv .claude-hooks/state/work/* .claude-hooks/work/\`. ` +
      `These artifacts will be lost on \`git clean -fdx\` until moved.`,
  };
};

const checkProbeRegistry = async (
  cwd: string,
): Promise<CheckResult | null> => {
  const probesFile = path.join(cwd, ".claude-hooks", "probes.ts");
  if (!fs.existsSync(probesFile)) return null;

  const isaPaths = collectIsaPaths(cwd);

  let registry: Readonly<Record<string, unknown>> = {};
  try {
    registry = await loadProbes(cwd);
  } catch (err) {
    return {
      name: "probe registry vs ISA tool columns",
      status: "FAIL",
      detail: `${probesFile}: load failed (${String(err).slice(0, 120)})`,
    };
  }
  const probeKeys = Object.keys(registry);

  if (probeKeys.length === 0) {
    return {
      name: "probe registry vs ISA tool columns",
      status: "INFO",
      detail: `${probesFile} present but exports zero probes — nothing to verify.`,
    };
  }

  if (isaPaths.length === 0) {
    return {
      name: "probe registry vs ISA tool columns",
      status: "INFO",
      detail: `${probesFile} exports ${probeKeys.length} probe(s) but no ISA at <cwd>/ISA.md or .claude-hooks/work/<slug>/ISA.md to validate against.`,
    };
  }

  const expectedTools = new Set<string>();
  let isasWithTestStrategy = 0;
  for (const isaPath of isaPaths) {
    let body: string;
    try {
      body = fs.readFileSync(isaPath, "utf8");
    } catch {
      continue;
    }
    const sections = parseSections(body);
    const tsBody = sections.get("Test Strategy")?.body ?? "";
    if (tsBody.length === 0) continue;
    isasWithTestStrategy += 1;
    for (const tool of parseTestStrategy(tsBody).values()) {
      expectedTools.add(tool);
    }
  }

  if (isasWithTestStrategy === 0) {
    return {
      name: "probe registry vs ISA tool columns",
      status: "FAIL",
      detail:
        `${probesFile} exports ${probeKeys.length} probe(s) but no ISA has a '## Test Strategy' section — ` +
        `the runtime never matches a probe to an ISC. Add a Test Strategy table with rows like: ` +
        `'| ISC-1 | bun | smoke | n/a | ${probeKeys[0]} |'`,
    };
  }

  const orphans = probeKeys.filter((k) => !expectedTools.has(k));
  if (orphans.length === 0) {
    const expectedSample = [...expectedTools].slice(0, 3).join(", ");
    return {
      name: "probe registry vs ISA tool columns",
      status: "PASS",
      detail: `${probeKeys.length} probe(s) all match an ISA tool column (e.g. ${expectedSample})`,
    };
  }

  const iscShaped = orphans.filter((k) => /^ISC-/i.test(k));
  const expectedSample = [...expectedTools]
    .slice(0, 3)
    .map((t) => `'${t}'`)
    .join(", ");
  const hint =
    iscShaped.length > 0
      ? ` Probe keys must match the ISA's 'tool' column (e.g. ${expectedSample}), NOT the 'isc' column. Found '${iscShaped[0]}' shaped like an ISC id — rename it to the tool name from the same Test Strategy row.`
      : ` Expected one of: ${expectedSample}.`;

  return {
    name: "probe registry vs ISA tool columns",
    status: "FAIL",
    detail: `${orphans.length}/${probeKeys.length} probe key(s) match no ISA tool column: [${orphans.join(", ")}].${hint}`,
  };
};

/**
 * Verify-map health check. Returns null when no `verify-map.yaml` exists
 * (feature is opt-in; absence is not a defect). When present, reports PASS
 * if the file parses to ≥1 rule, WARN on parse-to-zero-rules, FAIL on
 * read errors.
 */
const checkVerifyMap = (cwd: string): CheckResult | null => {
  const p = verifyMapPathFor(cwd);
  if (!fs.existsSync(p)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch (e) {
    return {
      name: "verify-map.yaml health",
      status: "FAIL",
      detail: `read failed: ${String(e).slice(0, 120)}`,
    };
  }
  const parsed = parseVerifyMapYaml(raw);
  if (parsed._tag === "fail") {
    return {
      name: "verify-map.yaml health",
      status: "FAIL",
      detail: `parse failed: ${parsed.message}`,
    };
  }
  if (parsed.rules.length === 0) {
    return {
      name: "verify-map.yaml health",
      status: "WARN",
      detail: "file present but no rules parsed (check indentation / `rules:` key)",
    };
  }
  return {
    name: "verify-map.yaml health",
    status: "PASS",
    detail: `${parsed.rules.length} rule(s) loaded`,
  };
};

export const runDoctor = async (
  argv: ReadonlyArray<string>,
  out: NodeJS.WritableStream = process.stdout,
): Promise<number> => {
  const args = parseArgs(argv);
  const env = currentProcessEnv();
  const runtimeConfig = runtimeConfigFromEnv(env);
  const results: CheckResult[] = [];
  results.push({
    name: "effective runtime config",
    status: "INFO",
    detail: JSON.stringify(summarizeRuntimeConfig(runtimeConfig)),
  });

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
  results.push(checkClassifierEnv(runtimeConfig));
  results.push(checkClassifierAuth(env));
  results.push(checkSkillBundle());
  results.push(checkActiveIsa(args.cwd));

  const migrationCheck = checkLegacyIsaMigration(args.cwd);
  if (migrationCheck !== null) results.push(migrationCheck);

  const probeCheck = await checkProbeRegistry(args.cwd);
  if (probeCheck !== null) results.push(probeCheck);

  const verifyMapCheck = checkVerifyMap(args.cwd);
  if (verifyMapCheck !== null) results.push(verifyMapCheck);

  const otel = await checkOtelEndpoint(runtimeConfig);
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
