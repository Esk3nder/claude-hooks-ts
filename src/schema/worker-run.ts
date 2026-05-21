import { Schema } from "effect"

export const WorkerStatus = Schema.Literal(
  "queued",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
)

export type WorkerStatus = Schema.Schema.Type<typeof WorkerStatus>

export const WorkerMode = Schema.Literal("read-only", "write-allowed")

export type WorkerMode = Schema.Schema.Type<typeof WorkerMode>

export const WorkerIsolation = Schema.Literal("none", "serial", "worktree", "patch")

export type WorkerIsolation = Schema.Schema.Type<typeof WorkerIsolation>

export const WorkerIntegrationStatus = Schema.Literal("pending", "applied", "rejected")

export type WorkerIntegrationStatus = Schema.Schema.Type<typeof WorkerIntegrationStatus>

export const WorkerConfidence = Schema.Literal("low", "medium", "high")

export type WorkerConfidence = Schema.Schema.Type<typeof WorkerConfidence>

export const WorkerFileReference = Schema.Struct({
  path: Schema.String,
  lines: Schema.optional(Schema.String),
  reason: Schema.String,
})

export type WorkerFileReference = Schema.Schema.Type<typeof WorkerFileReference>

export const WorkerChange = Schema.Struct({
  path: Schema.String,
  summary: Schema.String,
  diff_ref: Schema.optional(Schema.String),
})

export type WorkerChange = Schema.Schema.Type<typeof WorkerChange>

export const WorkerCommandResult = Schema.Struct({
  command: Schema.String,
  exit_code: Schema.optional(Schema.Number),
  result: Schema.String,
})

export type WorkerCommandResult = Schema.Schema.Type<typeof WorkerCommandResult>

export const WorkerVerification = Schema.Struct({
  check: Schema.String,
  status: Schema.Literal("passed", "failed", "not_run"),
  evidence: Schema.String,
})

export type WorkerVerification = Schema.Schema.Type<typeof WorkerVerification>

export const WorkerResult = Schema.Struct({
  summary: Schema.String,
  files_relevant: Schema.Array(WorkerFileReference),
  changes_made: Schema.Array(WorkerChange),
  commands_run: Schema.Array(WorkerCommandResult),
  verification: Schema.Array(WorkerVerification),
  risks: Schema.Array(Schema.String),
  blockers: Schema.Array(Schema.String),
  confidence: WorkerConfidence,
  next_action: Schema.optional(Schema.String),
})

export type WorkerResult = Schema.Schema.Type<typeof WorkerResult>

export const WorkerRun = Schema.Struct({
  worker_id: Schema.String,
  session_id: Schema.String,
  parent_task_id: Schema.optional(Schema.String),
  agent_id: Schema.optional(Schema.String),
  agent_type: Schema.String,
  mode: WorkerMode,
  status: WorkerStatus,
  prompt_hash: Schema.String,
  scope: Schema.String,
  created_at: Schema.String,
  started_at: Schema.optional(Schema.String),
  stopped_at: Schema.optional(Schema.String),
  attempts: Schema.Number,
  isolation: Schema.optional(WorkerIsolation),
  workspace_path: Schema.optional(Schema.String),
  patch_path: Schema.optional(Schema.String),
  patch_changed_files: Schema.optional(Schema.Array(Schema.String)),
  /**
   * P0-2: parent-cwd tracked-tree ref captured at SubagentStart for
   * read-only workers (via `git stash create` — falls back to "HEAD"
   * when the tree is clean). Compared against an end-of-run snapshot
   * at SubagentStop to detect mutations the worker did not declare in
   * `changes_made`. Optional: absent when the parent cwd wasn't a git
   * repo at start, when CommandRunner wasn't in context, or for write
   * workers (which use the patch-capture path instead).
   */
  baseline_ref: Schema.optional(Schema.String),
  output: Schema.optional(WorkerResult),
  result: Schema.optional(WorkerResult),
  failure_reason: Schema.optional(Schema.String),
  blocked_reason: Schema.optional(Schema.String),
  integration_status: Schema.optional(WorkerIntegrationStatus),
  integrated_at: Schema.optional(Schema.String),
})

export type WorkerRun = Schema.Schema.Type<typeof WorkerRun>

export const WorkerJobPayload = Schema.Struct({
  session_id: Schema.String,
  agent_type: Schema.String,
  mode: WorkerMode,
  prompt: Schema.String,
  prompt_hash: Schema.optional(Schema.String),
  prompt_redacted: Schema.optional(Schema.Boolean),
  scope: Schema.String,
  parent_task_id: Schema.optional(Schema.String),
  agent_id: Schema.optional(Schema.String),
  worker_id: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  timeout_ms: Schema.optional(Schema.Number),
  max_attempts: Schema.optional(Schema.Number),
})

export type WorkerJobPayload = Schema.Schema.Type<typeof WorkerJobPayload>

export const WorkerConflict = Schema.Struct({
  path: Schema.String,
  worker_ids: Schema.Array(Schema.String),
})

export type WorkerConflict = Schema.Schema.Type<typeof WorkerConflict>

export const WorkerIntegrationSummary = Schema.Struct({
  session_id: Schema.String,
  parent_task_id: Schema.optional(Schema.String),
  workers_total: Schema.Number,
  queued: Schema.Number,
  running: Schema.Number,
  blocked: Schema.Number,
  completed: Schema.Number,
  failed: Schema.Number,
  cancelled: Schema.Number,
  active_worker_ids: Schema.Array(Schema.String),
  completed_worker_ids: Schema.Array(Schema.String),
  failed_worker_ids: Schema.Array(Schema.String),
  blocked_worker_ids: Schema.Array(Schema.String),
  files_changed: Schema.Array(Schema.String),
  risks: Schema.Array(Schema.String),
  blockers: Schema.Array(Schema.String),
  conflicts: Schema.Array(WorkerConflict),
  integration_plan: Schema.Array(Schema.String),
  latest_integrated_at: Schema.optional(Schema.String),
  final_verification_required: Schema.Boolean,
  ready_for_integration: Schema.Boolean,
})

export type WorkerIntegrationSummary = Schema.Schema.Type<
  typeof WorkerIntegrationSummary
>

export const WorkerIntegrationApplyResult = Schema.Struct({
  worker_id: Schema.String,
  patch_path: Schema.String,
  applied: Schema.Boolean,
  check_only: Schema.Boolean,
  final_verification_required: Schema.Boolean,
})

export type WorkerIntegrationApplyResult = Schema.Schema.Type<
  typeof WorkerIntegrationApplyResult
>
