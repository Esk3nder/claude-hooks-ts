/** Input safety gates + capability gate (BUILD-SPEC §12, §14, constitution §6.1). Pure decisions. */
export type GateDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string; cls: "security" | "availability" }
  | { kind: "ask"; reason: string }

const DESTRUCTIVE: RegExp[] = [
  /\bgit\s+reset\s+--hard\b/, /\bgit\s+clean\s+-[a-z]*f/, /\bDROP\s+DATABASE\b/i,
  /\bmkfs\b/, /\bdd\b.*\bof=\/dev\//, /:\(\)\s*\{.*\};:/, /\bchmod\s+-R\s+777\b/, /\bgit\s+push\s+--force\b.*\b(main|master)\b/,
]
const SECRET_PATHS: RegExp[] = [/(^|\/)\.env(\.|$)/, /\.pem$/, /\.key$/, /(^|\/)\.npmrc$/, /(^|\/)\.aws\//, /id_rsa/]
const PROTECTED: RegExp[] = [/(^|\/)\.git\//, /(^|\/)\.claude-hooks\//, /(^|\/)\.claude\/settings/]
// briefs/ is model-authorable by design (BUILD-SPEC §2) — exempt it from the .claude-hooks/ protection.
const PROTECTED_EXEMPT: RegExp[] = [/(^|\/)\.claude-hooks\/briefs\//]
// generated/build outputs and lockfiles — absorbed from the old safety plane so v2 PreToolUse is complete.
const GENERATED: RegExp[] = [/(^|\/)node_modules\//, /(^|\/)(dist|build|out|\.next|\.nuxt|\.turbo|coverage)\//, /(^|\/)\.terraform\//]
const LOCKFILES: RegExp[] = [/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock)$/]

/**
 * Find an `rm` that is the actual command of a segment (start, or after a shell
 * separator) AND carries both recursive and force flags. Anchoring to command
 * position avoids false positives when "rm -rf /" merely appears inside a quoted
 * argument (e.g. a git commit message or an echo). Returns the segment, or null.
 */
function recursiveForceRmSegment(cmd: string): string | null {
  for (const seg of cmd.split(/&&|\|\||[\n;|&]/)) {
    const s = seg.trim()
    if (!/^rm\b/.test(s)) continue
    const hasR = /\s-[a-zA-Z]*r/i.test(s) || /\s--recursive\b/i.test(s)
    const hasF = /\s-[a-zA-Z]*f/i.test(s) || /\s--force\b/i.test(s)
    if (hasR && hasF) return s
  }
  return null
}

function unquote(tok: string): string {
  return tok.replace(/^["']|["']$/g, "")
}

/**
 * Filesystem paths a command would WRITE to: output redirects (`>`, `>>`, `2>`,
 * `&>`), `tee`, `cp`/`mv` destinations, and `dd of=`. Bash writes bypass the
 * Edit/Write path gate (PreToolUse only runs evalPathSafety on Edit/Write), so a
 * redirect like `echo … > .claude-hooks/policy.json` could tamper with protected
 * state. Running these targets through evalPathSafety closes that hole. Best-effort
 * shell parsing, per segment; quoted redirect targets are unquoted (a deliberate
 * `> "…protected…"` is caught), and a stray `>` inside an echoed string may produce
 * a harmless false-positive target (fails safe — evalPathSafety allows normal paths).
 */
function bashWriteTargets(cmd: string): string[] {
  const targets: string[] = []
  for (const seg of cmd.split(/&&|\|\||[\n;|&]/)) {
    const s = seg.trim()
    for (const m of s.matchAll(/>{1,2}\s*("[^"]*"|'[^']*'|[^\s;|&>]+)/g)) targets.push(unquote(m[1]!))
    const tokens = s.split(/\s+/)
    const c0 = tokens[0] ?? ""
    if (c0 === "tee") for (const t of tokens.slice(1)) { if (!t.startsWith("-")) targets.push(unquote(t)) }
    if (c0 === "cp" || c0 === "mv") { const a = tokens.slice(1).filter((t) => !t.startsWith("-")); if (a.length) targets.push(unquote(a[a.length - 1]!)) }
    for (const m of s.matchAll(/\bof=("[^"]*"|'[^']*'|[^\s;|&]+)/g)) targets.push(unquote(m[1]!))
  }
  return targets
}

export function evalBashSafety(cmd: string): GateDecision {
  for (const re of DESTRUCTIVE) if (re.test(cmd)) return { kind: "deny", reason: `destructive command blocked: ${re}`, cls: "security" }
  const rmSeg = recursiveForceRmSegment(cmd)
  if (rmSeg) {
    if (/\s(\/[^\s]*|~\/?|\$HOME\b|\$\{HOME\})/.test(rmSeg)) return { kind: "deny", reason: "destructive command blocked: recursive force-delete of an absolute/home path", cls: "security" }
    return { kind: "allow" } // relative recursive delete (build/dist/node_modules) — routine cleanup, no prompt
  }
  // a Bash write to a secret/protected/generated path is gated exactly like an Edit/Write
  for (const target of bashWriteTargets(cmd)) {
    const ps = evalPathSafety(target)
    if (ps.kind === "deny") return { kind: "deny", reason: `bash write to ${ps.reason}`, cls: "security" }
  }
  if (/\bcurl\b.*\|\s*sh\b/.test(cmd) || /\bnpm\s+publish\b/.test(cmd)) return { kind: "ask", reason: "high-blast-radius command" }
  return { kind: "allow" }
}

export function evalPathSafety(path: string): GateDecision {
  for (const re of SECRET_PATHS) if (re.test(path)) return { kind: "deny", reason: `secret path blocked: ${path}`, cls: "security" }
  if (PROTECTED_EXEMPT.some((re) => re.test(path))) return { kind: "allow" } // briefs/ stays model-writable
  for (const re of PROTECTED) if (re.test(path)) return { kind: "deny", reason: `protected path blocked: ${path}`, cls: "security" }
  for (const re of GENERATED) if (re.test(path)) return { kind: "deny", reason: `generated/build path blocked: ${path}`, cls: "security" }
  for (const re of LOCKFILES) if (re.test(path)) return { kind: "deny", reason: `lockfile edit blocked (regenerate via the package manager): ${path}`, cls: "security" }
  return { kind: "allow" }
}

/** Capability gate: a role may only use tools in its authority set. */
export function evalCapability(toolName: string, authorityTools: string[]): GateDecision {
  const base = toolName.split("(")[0]! // Bash(pwd) -> Bash
  if (!authorityTools.includes(base)) return { kind: "deny", reason: `capability: ${base} not in {${authorityTools.join(",")}}`, cls: "security" }
  return { kind: "allow" }
}
