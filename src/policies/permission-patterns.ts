/**
 * Stable pattern key derivation for PermissionRequest auto-approval.
 *
 * Auto-approval keys are intentionally exact by default. Earlier versions
 * bucketed Bash commands by their first two tokens and file tools by extension;
 * that was too broad for a permission cache because one approved `.ts` edit or
 * `npm test` command could generalize to unrelated future operations. Broad
 * matching belongs behind explicit policy, not the default ledger key.
 */

import * as crypto from "node:crypto"

const shortHash = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)

const normalizeBashCommand = (cmd: string): string =>
  cmd.trim().replace(/\s+/g, " ").replace(/;+$/, "").trim()

const normalizePathExact = (p: string): string =>
  p.replace(/\\/g, "/").replace(/\/+/g, "/")

const stableInput = (input: unknown): string => {
  try {
    return JSON.stringify(input)
  } catch {
    return "<unserializable>"
  }
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
        ? (toolInput as { command: string }).command
        : ""
    const normalized = normalizeBashCommand(cmd)
    return `${toolName}:exact:${shortHash(normalized)}`
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
        ? (toolInput as { file_path: string }).file_path
        : ""
    const normalized = normalizePathExact(fp)
    return `${toolName}:path:${shortHash(normalized)}`
  }
  return `${toolName}:exact:${shortHash(stableInput(toolInput))}`
}
