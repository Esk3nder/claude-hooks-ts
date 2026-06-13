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

export function evalBashSafety(cmd: string): GateDecision {
  for (const re of DESTRUCTIVE) if (re.test(cmd)) return { kind: "deny", reason: `destructive command blocked: ${re}`, cls: "security" }
  const rmSeg = recursiveForceRmSegment(cmd)
  if (rmSeg) {
    if (/\s(\/[^\s]*|~\/?|\$HOME\b|\$\{HOME\})/.test(rmSeg)) return { kind: "deny", reason: "destructive command blocked: recursive force-delete of an absolute/home path", cls: "security" }
    return { kind: "ask", reason: "recursive force-delete — confirm the target" }
  }
  if (/\bcurl\b.*\|\s*sh\b/.test(cmd) || /\bnpm\s+publish\b/.test(cmd)) return { kind: "ask", reason: "high-blast-radius command" }
  return { kind: "allow" }
}

export function evalPathSafety(path: string): GateDecision {
  for (const re of SECRET_PATHS) if (re.test(path)) return { kind: "deny", reason: `secret path blocked: ${path}`, cls: "security" }
  if (PROTECTED_EXEMPT.some((re) => re.test(path))) return { kind: "allow" } // briefs/ stays model-writable
  for (const re of PROTECTED) if (re.test(path)) return { kind: "deny", reason: `protected path blocked: ${path}`, cls: "security" }
  return { kind: "allow" }
}

/** Capability gate: a role may only use tools in its authority set. */
export function evalCapability(toolName: string, authorityTools: string[]): GateDecision {
  const base = toolName.split("(")[0]! // Bash(pwd) -> Bash
  if (!authorityTools.includes(base)) return { kind: "deny", reason: `capability: ${base} not in {${authorityTools.join(",")}}`, cls: "security" }
  return { kind: "allow" }
}
