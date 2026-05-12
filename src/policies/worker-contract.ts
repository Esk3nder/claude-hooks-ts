import { Schema } from "effect"
import { AgentInput } from "../schema/tool-inputs.ts"
import { lookupRole } from "./subagent-roles.ts"

export const WORKER_CONTRACT_MARKER = "<claude-hooks-worker-contract>"

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

export const renderWorkerContract = (
  subagentType: string | undefined,
): string => {
  const workerType = workerTypeFor(subagentType)
  const role = lookupRole(workerType)
  return [
    WORKER_CONTRACT_MARKER,
    `Worker ${workerType} (${role.mode}) contract:`,
    "- Own only the delegated subtask; do not silently expand to the user's whole objective.",
    `- Scope: ${role.scopeRule}`,
    `- ${role.outputContract}`,
    "- Use a concise structured result: summary, files_relevant, changes_made, commands_run, verification, risks, blockers.",
    "- If blocked or scope needs to widen, report that explicitly for orchestrator integration.",
    "</claude-hooks-worker-contract>",
  ].join("\n")
}

export const appendWorkerContract = (
  prompt: string,
  subagentType: string | undefined,
): string =>
  prompt.includes(WORKER_CONTRACT_MARKER)
    ? prompt
    : `${prompt.trimEnd()}\n\n${renderWorkerContract(subagentType)}`

export const evaluateWorkerTaskPrompt = (
  toolName: string,
  toolInput: unknown,
): WorkerTaskPromptDecision => {
  if (toolName !== "Task" && toolName !== "Agent") {
    return { kind: "passthrough" }
  }

  const decoded = Schema.decodeUnknownEither(AgentInput)(toolInput)
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
    decoded.right.subagent_type ?? decoded.right.agent_type,
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
