import { Schema } from "effect"
import { RawWorkerLaunchInput as AgentInput } from "./worker.ts"

export const BashInput = Schema.Struct({
  command: Schema.String,
  description: Schema.optional(Schema.String),
  timeout: Schema.optional(Schema.Number),
})

export const ReadInput = Schema.Struct({
  file_path: Schema.String,
  limit: Schema.optional(Schema.Number),
  offset: Schema.optional(Schema.Number),
})

export const EditInput = Schema.Struct({
  file_path: Schema.String,
  old_string: Schema.String,
  new_string: Schema.String,
  replace_all: Schema.optional(Schema.Boolean),
})

export const WriteInput = Schema.Struct({
  file_path: Schema.String,
  content: Schema.String,
})

export const MultiEditInput = Schema.Struct({
  file_path: Schema.String,
  edits: Schema.Array(
    Schema.Struct({
      old_string: Schema.String,
      new_string: Schema.String,
      replace_all: Schema.optional(Schema.Boolean),
    }),
  ),
})

export const GlobInput = Schema.Struct({
  pattern: Schema.String,
  path: Schema.optional(Schema.String),
})

export const GrepInput = Schema.Struct({
  pattern: Schema.String,
  path: Schema.optional(Schema.String),
  glob: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  output_mode: Schema.optional(Schema.String),
  "-i": Schema.optional(Schema.Boolean),
  "-n": Schema.optional(Schema.Boolean),
  multiline: Schema.optional(Schema.Boolean),
  head_limit: Schema.optional(Schema.Number),
})

export const WebFetchInput = Schema.Struct({
  url: Schema.String,
  prompt: Schema.String,
})

export const WebSearchInput = Schema.Struct({
  query: Schema.String,
  allowed_domains: Schema.optional(Schema.Array(Schema.String)),
  blocked_domains: Schema.optional(Schema.Array(Schema.String)),
})

export { AgentInput }

export const MCPToolInput = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
})

const REGISTRY: Record<string, Schema.Schema<unknown, unknown, never>> = {
  Bash: BashInput as unknown as Schema.Schema<unknown, unknown, never>,
  Read: ReadInput as unknown as Schema.Schema<unknown, unknown, never>,
  Edit: EditInput as unknown as Schema.Schema<unknown, unknown, never>,
  Write: WriteInput as unknown as Schema.Schema<unknown, unknown, never>,
  MultiEdit: MultiEditInput as unknown as Schema.Schema<unknown, unknown, never>,
  Glob: GlobInput as unknown as Schema.Schema<unknown, unknown, never>,
  Grep: GrepInput as unknown as Schema.Schema<unknown, unknown, never>,
  WebFetch: WebFetchInput as unknown as Schema.Schema<unknown, unknown, never>,
  WebSearch: WebSearchInput as unknown as Schema.Schema<unknown, unknown, never>,
  Agent: AgentInput as unknown as Schema.Schema<unknown, unknown, never>,
  Task: AgentInput as unknown as Schema.Schema<unknown, unknown, never>,
}

export const toolInputSchemaFor = (
  toolName: string,
): Schema.Schema<unknown, unknown, never> => {
  const hit = REGISTRY[toolName]
  if (hit !== undefined) return hit
  if (toolName.startsWith("mcp__")) {
    return MCPToolInput as unknown as Schema.Schema<unknown, unknown, never>
  }
  return Schema.Unknown as unknown as Schema.Schema<unknown, unknown, never>
}
