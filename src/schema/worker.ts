import { Schema } from "effect"

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

const firstNonBlank = (
  ...values: ReadonlyArray<string | undefined>
): string | undefined => {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value
  }
  return undefined
}

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
