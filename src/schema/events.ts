import { Schema } from "effect"

export type EventStreamName = string

export interface EventStream<A> {
  readonly name: EventStreamName
  readonly path: string
  readonly schema: Schema.Schema<A>
  readonly maxLineBytes?: number
  readonly maxTailBytes?: number
  readonly maxRecords?: number
  readonly redact?: (event: A) => unknown
}

export const eventStream = <A>(
  name: EventStreamName,
  filePath: string,
  schema: Schema.Schema<A>,
  options: {
    readonly maxLineBytes?: number
    readonly maxTailBytes?: number
    readonly maxRecords?: number
    readonly redact?: (event: A) => unknown
  } = {},
): EventStream<A> => ({
  name,
  path: filePath,
  schema,
  ...options,
})

export const ApprovalStatusSchema = Schema.Literal("approved", "denied", "pending")

export const ApprovalRecordSchema = Schema.Struct({
  cwd: Schema.String,
  pattern: Schema.String,
  status: ApprovalStatusSchema,
  recordedAt: Schema.Number,
})

export type ApprovalEvent = Schema.Schema.Type<typeof ApprovalRecordSchema>

export const ElicitationActionSchema = Schema.Literal("accept", "decline", "cancel")

export const ElicitationRecordSchema = Schema.Struct({
  ts: Schema.Number,
  server: Schema.String,
  tool: Schema.String,
  signature: Schema.String,
  action: ElicitationActionSchema,
  content: Schema.optional(Schema.Unknown),
  cwd: Schema.String,
})

export type ElicitationEvent = Schema.Schema.Type<typeof ElicitationRecordSchema>

export const PendingElicitationRecordSchema = Schema.Struct({
  ts: Schema.Number,
  sessionId: Schema.String,
  cwd: Schema.String,
  server: Schema.String,
  tool: Schema.String,
  requestSignature: Schema.String,
})

export type PendingElicitationEvent = Schema.Schema.Type<typeof PendingElicitationRecordSchema>

export const LedgerEntrySchema = Schema.Struct({
  timestamp: Schema.Number,
  event: Schema.String,
  sessionId: Schema.String,
  data: Schema.Unknown,
})

export type LedgerEvent = Schema.Schema.Type<typeof LedgerEntrySchema>

export const ClassifierTelemetryRecordSchema = Schema.Struct({
  timestamp: Schema.String,
  session_id: Schema.String,
  prompt_hash: Schema.String,
  prompt_excerpt: Schema.String,
  mode: Schema.String,
  tier: Schema.Union(Schema.String, Schema.Number, Schema.Null),
  mode_reason: Schema.String,
  source: Schema.String,
  latency_ms: Schema.Number,
})

export type ClassifierTelemetryEvent = Schema.Schema.Type<typeof ClassifierTelemetryRecordSchema>

export const PermissionDeniedRecordSchema = Schema.Struct({
  session_id: Schema.String,
  tool_name: Schema.String,
  tool_input: Schema.Unknown,
  pattern_key: Schema.String,
  denial_reason: Schema.String,
  permission_mode: Schema.Union(Schema.String, Schema.Null),
  ts: Schema.String,
})

export type PermissionDeniedEvent = Schema.Schema.Type<typeof PermissionDeniedRecordSchema>

export const WorkerJobSchema = Schema.Struct({
  id: Schema.String,
  queue: Schema.String,
  payload: Schema.Unknown,
  enqueuedAt: Schema.Number,
  attempts: Schema.Number,
})

export type WorkerJob = Schema.Schema.Type<typeof WorkerJobSchema>

export const WorktreeRemoveRecordSchema = Schema.Struct({
  session_id: Schema.String,
  worktree_path: Schema.String,
  ts: Schema.String,
})

export type WorktreeRemoveEvent = Schema.Schema.Type<typeof WorktreeRemoveRecordSchema>
