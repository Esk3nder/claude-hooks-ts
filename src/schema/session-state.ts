import { Schema } from "effect"

/**
 * Schema for the on-disk SessionState record. Used to validate untrusted
 * JSON read from `.claude-hooks/state/<session-id>.json`. Any decode failure
 * triggers a backup-and-reset path in `services/session-state.ts`.
 *
 * Mirrors `SessionStateRecord` in services/session-state.ts.
 */
export const SessionStateRecordSchema = Schema.Struct({
  files_read: Schema.Array(Schema.String),
  files_changed: Schema.Array(Schema.String),
  commands_run: Schema.Array(Schema.String),
  commands_failed: Schema.Array(Schema.String),
  tests_run: Schema.Array(Schema.String),
  verification_status: Schema.Literal("passed", "failed", "none"),
  next_required_action: Schema.NullOr(Schema.String),
  stop_blocked_once: Schema.Boolean,
  source_urls: Schema.Array(Schema.String),
  subagent_starts: Schema.Array(Schema.String),
  subagent_stops: Schema.Array(Schema.String),
  last_workflow: Schema.NullOr(Schema.String),
})

export type SessionStateRecordSchemaType = Schema.Schema.Type<
  typeof SessionStateRecordSchema
>
