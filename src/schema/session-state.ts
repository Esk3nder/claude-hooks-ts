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
  verification_at: Schema.NullOr(Schema.String),
  next_required_action: Schema.NullOr(Schema.String),
  stop_blocked_once: Schema.Boolean,
  source_urls: Schema.Array(Schema.String),
  subagent_starts: Schema.Array(Schema.String),
  subagent_stops: Schema.Array(Schema.String),
  last_workflow: Schema.NullOr(Schema.String),
  /**
   * True when the upstream prompt explicitly asked for web-research-style
   * sources (search the web, cite authoritative sources, etc.). Drives the
   * Stop research-mode source-ledger gate. Deliberately decoupled from
   * `last_workflow` so loose single-word matches in the priming workflow
   * regex cannot force a Stop block.
   */
  requires_web_sources: Schema.Boolean,
  /**
   * Opt-out for the Stop research-mode source-ledger gate. Set to `true`
   * only when an active ISA's frontmatter declares
   * `source_ledger: not_applicable` (detected by post-edit-quality on
   * an ISA Write/Edit). When true, the Stop gate suppresses the
   * source-ledger block even if `requires_web_sources` is true — used
   * for UI builds from a pasted spec, pure-code tasks whose prompt
   * mentions "current best practices", etc. Default false; the opt-out
   * must be explicitly declared by the user/agent in the ISA.
   */
  source_ledger_opt_out: Schema.Boolean,
  /**
   * Engagement bookkeeping written by `prompt-router` from the
   * classifier and read by Stop / PostToolUse gates. Together they let the
   * Stop gate enforce "ALGORITHM E3+ ran without an ISA" (absence-is-failure)
   * instead of nooping on absence.
   */
  last_mode: Schema.NullOr(Schema.String),
  last_tier: Schema.NullOr(Schema.Number),
  engagement_required: Schema.Boolean,
  expected_isa_path: Schema.NullOr(Schema.String),
  /**
   * Stable absolute project root frozen at engagement creation. The Stop
   * gate, TaskCompleted gate, and PreToolUse engagement gate use this as
   * the ISA-lookup root instead of mutable `payload.cwd`, so a Bash `cd`
   * after engagement does not move the expected ISA target.
   */
  session_root: Schema.NullOr(Schema.String),
  /**
   * Frozen absolute form of `expected_isa_path`. Set when engagement is
   * declared; the PreToolUse gate compares against this instead of
   * re-resolving the relative path against the current shell cwd.
   */
  expected_isa_path_absolute: Schema.NullOr(Schema.String),
  isa_engaged_at: Schema.NullOr(Schema.String),
  /**
   * Names of regenerate.yaml rules skipped on the last Stop because the
   * remaining wall-clock budget was too small. Read by the next
   * `UserPromptSubmit` to surface a one-line heads-up; cleared once
   * surfaced. (D3)
   */
  regenerate_skipped: Schema.Array(Schema.String),
})

export type SessionStateRecordSchemaType = Schema.Schema.Type<
  typeof SessionStateRecordSchema
>
