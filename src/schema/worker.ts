import { Schema } from "effect"
import { firstNonBlank } from "./normalized.ts"

export const RawWorkerLaunchInput = Schema.Struct({
  description: Schema.String,
  prompt: Schema.String,
  agent_type: Schema.optional(Schema.String),
  subagent_type: Schema.optional(Schema.String),
})

export type RawWorkerLaunchInput = Schema.Schema.Type<typeof RawWorkerLaunchInput>

export const NormalizedWorkerLaunchInput = Schema.Struct({
  description: Schema.String,
  prompt: Schema.String,
  agent_type: Schema.optional(Schema.String),
})

export type NormalizedWorkerLaunchInput = Schema.Schema.Type<
  typeof NormalizedWorkerLaunchInput
>

export const normalizeWorkerLaunchInput = (
  input: RawWorkerLaunchInput,
): NormalizedWorkerLaunchInput => {
  const agentType = firstNonBlank(input.agent_type, input.subagent_type)
  const base = {
    description: input.description,
    prompt: input.prompt,
  }
  return agentType === undefined ? base : { ...base, agent_type: agentType }
}

export const WorkerLaunchInput = Schema.transform(
  RawWorkerLaunchInput,
  NormalizedWorkerLaunchInput,
  {
    decode: normalizeWorkerLaunchInput,
    encode: (_encoded, input) => input,
  },
)

export type WorkerLaunchInput = Schema.Schema.Type<typeof WorkerLaunchInput>
