/**
 * Stable pattern key derivation for PermissionRequest auto-approval.
 * The key is what we look up in the Approvals ledger.
 */

const truncate = (s: string, n: number): string =>
  s.length > n ? s.slice(0, n) + "…" : s

const normalizeBashCommand = (cmd: string): string => {
  // collapse whitespace, drop trailing semicolons
  const c = cmd.trim().replace(/\s+/g, " ").replace(/;+$/, "")
  // bucket by first 2 tokens (e.g. "git status", "npm test")
  const tokens = c.split(" ")
  if (tokens.length === 0) return "bash:empty"
  const head = tokens.slice(0, 2).join(" ")
  return `bash:${head}`
}

const normalizePath = (p: string): string => {
  // bucket by extension if file path, else by leading 2 segments
  const ext = p.match(/\.[a-zA-Z0-9]+$/)
  if (ext) return `path:*${ext[0]}`
  const segs = p.split("/").filter((s) => s.length > 0)
  return `path:/${segs.slice(0, 2).join("/")}`
}

export const derivePatternKey = (
  toolName: string,
  toolInput: unknown,
): string => {
  if (toolName === "Bash") {
    const cmd =
      typeof toolInput === "object" &&
      toolInput !== null &&
      typeof (toolInput as { command?: unknown }).command === "string"
        ? ((toolInput as { command: string }).command)
        : ""
    return `${toolName}:${normalizeBashCommand(cmd)}`
  }
  if (
    toolName === "Edit" ||
    toolName === "Write" ||
    toolName === "Read" ||
    toolName === "MultiEdit" ||
    toolName === "Update"
  ) {
    const fp =
      typeof toolInput === "object" &&
      toolInput !== null &&
      typeof (toolInput as { file_path?: unknown }).file_path === "string"
        ? ((toolInput as { file_path: string }).file_path)
        : ""
    return `${toolName}:${normalizePath(fp)}`
  }
  // generic: tool + JSON shape signature (truncated)
  let shape = ""
  try {
    shape = JSON.stringify(toolInput)
  } catch {
    shape = "<unserializable>"
  }
  return `${toolName}:${truncate(shape, 80)}`
}
