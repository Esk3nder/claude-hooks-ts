import { Schema } from "effect"
import * as crypto from "node:crypto"
import { WorkerLaunchInput } from "../schema/worker.ts"
import { lookupRole } from "./subagent-roles.ts"

export const WORKER_CONTRACT_MARKER = "<claude-hooks-worker-contract>"
export const WORKER_CONTRACT_END_MARKER = "</claude-hooks-worker-contract>"
export const CURRENT_WORKER_CONTRACT_VERSION = "1"

// Deliberately semantic rather than a hash of raw prose: wording can be
// clarified without invalidating historical worker runs, but changing output
// shape or orchestration obligations must update this list/version.
const WORKER_CONTRACT_SHAPE = [
  `version:${CURRENT_WORKER_CONTRACT_VERSION}`,
  "marker",
  "worker-role-mode",
  "scope-ownership",
  "role-boundary",
  "output-contract",
  "worker-result-json-keys",
  "change-diff-ref",
  "blocker-scope-widening",
]

export const CURRENT_WORKER_CONTRACT_HASH = crypto
  .createHash("sha256")
  .update(WORKER_CONTRACT_SHAPE.join("\n"))
  .digest("hex")
  .slice(0, 16)

export type WorkerTaskPromptDecision =
  | { readonly kind: "passthrough" }
  | { readonly kind: "ask"; readonly reason: string }
  | {
      readonly kind: "rewrite"
      readonly reason: string
      readonly updatedInput: Record<string, unknown>
    }

const workerTypeFor = (subagentType: string | undefined): string =>
  typeof subagentType === "string" && subagentType.trim().length > 0
    ? subagentType.trim()
    : "general-purpose"

export interface WorkerContractMetadata {
  readonly contract_version?: string
  readonly contract_hash?: string
}

const contractBlockForPrompt = (prompt: string): string | null => {
  const start = prompt.indexOf(WORKER_CONTRACT_MARKER)
  if (start < 0) return null
  const end = prompt.indexOf(WORKER_CONTRACT_END_MARKER, start)
  if (end < 0) return null
  return prompt.slice(start, end + WORKER_CONTRACT_END_MARKER.length)
}

export const parseWorkerContractMetadata = (
  prompt: string | undefined,
): WorkerContractMetadata | null => {
  if (prompt === undefined) return null
  const block = contractBlockForPrompt(prompt)
  if (block === null) return null
  const version = /^\s*Contract version:\s*([^\n]+?)\s*$/im.exec(block)?.[1]
  const hash = /^\s*Contract hash:\s*([^\n]+?)\s*$/im.exec(block)?.[1]
  return {
    ...(version === undefined ? {} : { contract_version: version }),
    ...(hash === undefined ? {} : { contract_hash: hash }),
  }
}

export const hasCurrentWorkerContract = (prompt: string | undefined): boolean => {
  const metadata = parseWorkerContractMetadata(prompt)
  return (
    metadata !== null &&
    metadata.contract_version === CURRENT_WORKER_CONTRACT_VERSION &&
    metadata.contract_hash === CURRENT_WORKER_CONTRACT_HASH
  )
}

const replaceWorkerContract = (
  prompt: string,
  subagentType: string | undefined,
): string => {
  const start = prompt.indexOf(WORKER_CONTRACT_MARKER)
  if (start < 0) return `${prompt.trimEnd()}\n\n${renderWorkerContract(subagentType)}`
  const end = prompt.indexOf(WORKER_CONTRACT_END_MARKER, start)
  const suffix = end < 0
    ? prompt.slice(start + WORKER_CONTRACT_MARKER.length)
    : prompt.slice(end + WORKER_CONTRACT_END_MARKER.length)
  return `${prompt.slice(0, start).trimEnd()}\n\n${renderWorkerContract(subagentType)}${suffix}`
}

export const renderWorkerContract = (
  subagentType: string | undefined,
): string => {
  const workerType = workerTypeFor(subagentType)
  const role = lookupRole(workerType)
  return [
    WORKER_CONTRACT_MARKER,
    `Contract version: ${CURRENT_WORKER_CONTRACT_VERSION}`,
    `Contract hash: ${CURRENT_WORKER_CONTRACT_HASH}`,
    `Worker ${workerType} (${role.mode}) contract:`,
    "- Own only the delegated subtask; do not silently expand to the user's whole objective.",
    `- Role boundary: ${role.scopeRule}`,
    `- ${role.outputContract}`,
    "- Return only strict JSON matching WorkerResult: summary, files_relevant, changes_made, commands_run, verification, risks, blockers, confidence, next_action?.",
    "- For changes_made entries, include path, summary, and diff_ref when an isolated diff/patch exists.",
    "- If blocked or scope needs to widen, report that explicitly for orchestrator integration.",
    WORKER_CONTRACT_END_MARKER,
  ].join("\n")
}

export const appendWorkerContract = (
  prompt: string,
  subagentType: string | undefined,
): string =>
  hasCurrentWorkerContract(prompt)
    ? prompt
    : replaceWorkerContract(prompt, subagentType)

export const evaluateWorkerTaskPrompt = (
  toolName: string,
  toolInput: unknown,
): WorkerTaskPromptDecision => {
  if (toolName !== "Task" && toolName !== "Agent") {
    return { kind: "passthrough" }
  }

  const decoded = Schema.decodeUnknownEither(WorkerLaunchInput)(toolInput)
  if (decoded._tag === "Left") {
    return {
      kind: "ask",
      reason:
        "Worker launch input did not match expected Task/Agent schema; confirming so worker scope cannot be silently lost.",
    }
  }

  const inputObj =
    typeof toolInput === "object" && toolInput !== null
      ? (toolInput as Record<string, unknown>)
      : {}
  const nextPrompt = appendWorkerContract(
    decoded.right.prompt,
    decoded.right.agent_type,
  )
  if (nextPrompt === decoded.right.prompt) return { kind: "passthrough" }

  return {
    kind: "rewrite",
    reason: "Worker task prompt annotated with bounded scope and output contract.",
    updatedInput: {
      ...inputObj,
      prompt: nextPrompt,
    },
  }
}
