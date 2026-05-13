import { Schema } from "effect"
import { createHash } from "node:crypto"
import { HookPayload } from "./payloads.ts"

export const RawHookPayload = HookPayload
export type RawHookPayload = HookPayload

type RawSubagentStart = Extract<RawHookPayload, { readonly _tag: "SubagentStart" }>
type RawSubagentStop = Extract<RawHookPayload, { readonly _tag: "SubagentStop" }>

type NonSubagentHookEvent = Exclude<
  RawHookPayload,
  RawSubagentStart | RawSubagentStop
>

export type NormalizedSubagentStart = Omit<
  RawSubagentStart,
  "agent_type" | "agent_id" | "subagent_type" | "task_id"
> & {
  readonly agent_type: string
  readonly agent_id: string
}

export type NormalizedSubagentStop = Omit<
  RawSubagentStop,
  "agent_type" | "agent_id" | "subagent_type" | "task_id" | "output" | "result"
> & {
  readonly agent_type: string
  readonly agent_id: string
  readonly output?: string
}

export type NormalizedHookEvent =
  | NonSubagentHookEvent
  | NormalizedSubagentStart
  | NormalizedSubagentStop

const sha1Short = (input: string): string =>
  createHash("sha1").update(input).digest("hex").slice(0, 16)

export const stableHookPayloadHash = (payload: Record<string, unknown>): string => {
  const keys = Object.keys(payload)
    .filter((k) => k !== "session_id")
    .sort()
  const canonical = keys.map((k) => [k, payload[k]] as const)
  return sha1Short(JSON.stringify(canonical))
}

const firstNonBlank = (
  ...values: ReadonlyArray<string | undefined>
): string | undefined => {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value
  }
  return undefined
}

const normalizeAgentType = (payload: {
  readonly agent_type?: string | undefined
  readonly subagent_type?: string | undefined
}): string => firstNonBlank(payload.agent_type, payload.subagent_type) ?? "unknown"

const normalizeAgentId = (payload: {
  readonly agent_id?: string | undefined
  readonly task_id?: string | undefined
} & Record<string, unknown>): string =>
  firstNonBlank(payload.agent_id, payload.task_id) ??
  `h${stableHookPayloadHash(payload)}`

const normalizeSubagentStart = (
  payload: RawSubagentStart,
): NormalizedSubagentStart => {
  const {
    agent_type: _agentType,
    agent_id: _agentId,
    subagent_type: _legacySubagentType,
    task_id: _legacyTaskId,
    ...base
  } = payload
  void _agentType
  void _agentId
  void _legacySubagentType
  void _legacyTaskId
  return {
    ...base,
    agent_type: normalizeAgentType(payload),
    agent_id: normalizeAgentId(payload),
  }
}

const normalizeSubagentStop = (
  payload: RawSubagentStop,
): NormalizedSubagentStop => {
  const {
    agent_type: _agentType,
    agent_id: _agentId,
    subagent_type: _legacySubagentType,
    task_id: _legacyTaskId,
    output: _output,
    result: _legacyResult,
    ...base
  } = payload
  void _agentType
  void _agentId
  void _legacySubagentType
  void _legacyTaskId
  void _output
  void _legacyResult

  const normalized = {
    ...base,
    agent_type: normalizeAgentType(payload),
    agent_id: normalizeAgentId(payload),
  }
  const output = firstNonBlank(payload.output, payload.result)
  return output === undefined ? normalized : { ...normalized, output }
}

export const normalizeHookEvent = (
  payload: RawHookPayload,
): NormalizedHookEvent => {
  switch (payload._tag) {
    case "SubagentStart":
      return normalizeSubagentStart(payload)
    case "SubagentStop":
      return normalizeSubagentStop(payload)
    default:
      return payload
  }
}

const NormalizedHookEventSchema = Schema.transform(
  RawHookPayload,
  RawHookPayload,
  {
    strict: false,
    decode: (payload) => normalizeHookEvent(payload),
    encode: (_encoded, payload) => payload,
  },
)

export const NormalizedHookEvent =
  NormalizedHookEventSchema as unknown as Schema.Schema<
    NormalizedHookEvent,
    unknown,
    never
  >
