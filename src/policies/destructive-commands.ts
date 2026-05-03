import type { PolicyDecision } from "./types.ts"

/**
 * Catastrophic command patterns. Matches → deny.
 * Patterns are conservative; false positives are acceptable for this class.
 */
export const DENY_PATTERNS: ReadonlyArray<{
  readonly re: RegExp
  readonly label: string
}> = [
  { re: /\brm\s+-[rRfF]*[rR][rRfF]*\s+\/(\s|$)/, label: "rm -rf /" },
  { re: /\brm\s+-[rRfF]*[rR][rRfF]*\s+(--no-preserve-root|\/[*?])/, label: "rm -rf root variant" },
  { re: /\bsudo\s+rm\b/, label: "sudo rm" },
  { re: /\bgit\s+reset\s+--hard\b/, label: "git reset --hard" },
  { re: /\bgit\s+clean\s+-[a-z]*f[a-z]*d[a-z]*x?[a-z]*\b/i, label: "git clean -fdx" },
  { re: /\bgit\s+clean\s+-[a-z]*d[a-z]*f[a-z]*x?[a-z]*\b/i, label: "git clean -fdx" },
  { re: /\bgit\s+push\s+(?:.*\s)?(--force|-f)\b.*\b(main|master)\b/, label: "force push to main/master" },
  { re: /\bgit\s+push\s+(?:.*\s)?(main|master)\s+(--force|-f)\b/, label: "force push to main/master" },
  { re: /\bdrop\s+database\b/i, label: "DROP DATABASE" },
  { re: /\btruncate\s+table\b/i, label: "TRUNCATE TABLE" },
  { re: /\bterraform\s+destroy\b/, label: "terraform destroy" },
  { re: /\bkubectl\s+delete\b/, label: "kubectl delete" },
  { re: /\baws\s+s3\s+rb\b/, label: "aws s3 rb (remove bucket)" },
  { re: /\bdd\s+if=.*\s+of=\/dev\/[sh]d/, label: "dd to raw disk" },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/, label: "mkfs" },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, label: "fork bomb" },
  { re: /\bshutdown\b/, label: "shutdown" },
  { re: /\breboot\b/, label: "reboot" },
  { re: /\bchmod\s+-R\s+777\b/, label: "chmod -R 777" },
]

/** Patterns that warrant ask (not auto-deny). */
export const ASK_PATTERNS: ReadonlyArray<{
  readonly re: RegExp
  readonly label: string
}> = [
  { re: /\brm\s+-[rRfF]+\b/, label: "recursive/forced rm" },
  { re: /\brm\s+--recursive\b/, label: "rm --recursive" },
  { re: /\bgit\s+push\s+(?:.*\s)?(--force|-f)\b/, label: "git push --force" },
  { re: /\bgit\s+push\s+--force-with-lease\b/, label: "git push --force-with-lease" },
  { re: /\bnpm\s+publish\b/, label: "npm publish" },
  { re: /\bcurl\s+[^\n]*\|\s*(sh|bash|zsh)\b/, label: "curl | sh" },
  { re: /\bwget\s+[^\n]*\|\s*(sh|bash|zsh)\b/, label: "wget | sh" },
]

export const evaluateDestructiveCommand = (
  command: string,
): PolicyDecision => {
  const cmd = command.replace(/\s+/g, " ").trim()
  for (const { re, label } of DENY_PATTERNS) {
    if (re.test(cmd)) {
      return {
        kind: "deny",
        reason: `Destructive command blocked: ${label}.`,
      }
    }
  }
  for (const { re, label } of ASK_PATTERNS) {
    if (re.test(cmd)) {
      return {
        kind: "ask",
        reason: `Confirm before running: ${label}.`,
      }
    }
  }
  return { kind: "passthrough" }
}
