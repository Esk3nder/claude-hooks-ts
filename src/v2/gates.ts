/** Input safety gates + capability gate (BUILD-SPEC §12, §14, constitution §6.1). Pure decisions. */
export type GateDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string; cls: "security" | "availability" }
  | { kind: "ask"; reason: string }

const DESTRUCTIVE: RegExp[] = [
  /\brm\s+-rf\s+\/(?:\s|$)/, /\bgit\s+reset\s+--hard\b/, /\bgit\s+clean\s+-[a-z]*f/, /\bDROP\s+DATABASE\b/i,
  /\bmkfs\b/, /\bdd\b.*\bof=\/dev\//, /:\(\)\s*\{.*\};:/, /\bchmod\s+-R\s+777\b/, /\bgit\s+push\s+--force\b.*\b(main|master)\b/,
]
const SECRET_PATHS: RegExp[] = [/(^|\/)\.env(\.|$)/, /\.pem$/, /\.key$/, /(^|\/)\.npmrc$/, /(^|\/)\.aws\//, /id_rsa/]
const PROTECTED: RegExp[] = [/(^|\/)\.git\//, /(^|\/)\.claude-hooks\//, /(^|\/)\.claude\/settings/]

export function evalBashSafety(cmd: string): GateDecision {
  for (const re of DESTRUCTIVE) if (re.test(cmd)) return { kind: "deny", reason: `destructive command blocked: ${re}`, cls: "security" }
  if (/\bcurl\b.*\|\s*sh\b/.test(cmd) || /\bnpm\s+publish\b/.test(cmd)) return { kind: "ask", reason: "high-blast-radius command" }
  return { kind: "allow" }
}

export function evalPathSafety(path: string): GateDecision {
  for (const re of SECRET_PATHS) if (re.test(path)) return { kind: "deny", reason: `secret path blocked: ${path}`, cls: "security" }
  for (const re of PROTECTED) if (re.test(path)) return { kind: "deny", reason: `protected path blocked: ${path}`, cls: "security" }
  return { kind: "allow" }
}

/** Capability gate: a role may only use tools in its authority set. */
export function evalCapability(toolName: string, authorityTools: string[]): GateDecision {
  const base = toolName.split("(")[0]! // Bash(pwd) -> Bash
  if (!authorityTools.includes(base)) return { kind: "deny", reason: `capability: ${base} not in {${authorityTools.join(",")}}`, cls: "security" }
  return { kind: "allow" }
}
