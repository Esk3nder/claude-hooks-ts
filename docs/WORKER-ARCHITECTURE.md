# Worker Architecture

`claude-hooks-ts` has two worker surfaces:

- the hot hook control plane around Claude Code `Task` / `Agent` launches and
  subagent lifecycle events,
- an explicit `WorkerSupervisor` service for queued worker execution.

The hook path does not secretly start background workers. Spawning happens only
when the supervisor is called, and all launches go through the existing
`ClaudeSubprocess` / `CommandRunner` chokepoints.

## Control points

1. `PreToolUse` for `Task` / `Agent`
   - Rewrites the launch prompt once with a worker contract marker.
   - Preserves the caller's existing tool input fields.
   - Does not block valid launches.

2. `SubagentStart`
   - Injects role-specific scope rules into the worker context.
   - Adds a role-specific output contract so the worker returns integrable
     results instead of free-form chatter.
   - Creates / marks a typed `WorkerRun` as running when worker services are
     present.

3. `SubagentStop`
   - Requires investigative workers to return concrete evidence.
   - Evidence must include an anchor such as `file:line` or a command plus
     confidence / next-action / risk language.
   - Requires strict `WorkerResult` JSON and records completed or blocked
     lifecycle state.
   - Blocks write-worker outputs that report file changes without a captured
     isolated patch.

4. `TaskCompleted`
   - Requires acceptance criteria and non-empty evidence before a task can be
     marked complete.
   - Continues to consult active ISA verification when present.
   - Blocks parent completion while correlated worker runs are queued, running,
     blocked, failed, or in conflict.

5. `TeammateIdle`
   - Blocks idle handoff when files changed but verification has not passed.

6. Correlated `PreToolUse`
   - If a tool event carries `agent_id`, `task_id`, or `worker_id`, role
     permissions are enforced against the active `WorkerRun`.
   - Read-only / unknown workers cannot use write tools and cannot run
     destructive Bash.
   - Write workers can edit only inside their assigned scope.

## Worker output contract

Workers are asked to return:

- `summary`
- `files_relevant`
- `changes_made`
- `commands_run`
- `verification`
- `risks`
- `blockers`

`WorkerResult` now exists as a strict schema for that contract, and
`WorkerRun` records provide a durable lifecycle ledger for queued, running,
blocked, completed, failed, and cancelled workers. The ledger stores prompt
hashes and typed results, not raw prompts.

## Runtime services

The package wires these services into the app layer:

- `WorkerQueueLive` owns bounded producer/consumer semantics for worker jobs.
- `WorkerRunsLive` owns typed lifecycle snapshots and structured result
  validation.
- `WorkerExecutorLive` invokes workers through `ClaudeSubprocess`.
- `WorkerSupervisorLive` enqueues, consumes, times out, retries, and completes
  worker jobs. Retry policy is a `Schedule`; write workers are serially
  isolated by default. Serial mode prevents parallel write workers, but
  changed-file outputs are not integration-ready unless a patch/worktree mode
  captured an isolated patch.
- `workerWriteIsolation=worktree` / `patch` runs write workers in a temporary
  git worktree, captures the resulting binary diff under
  `.claude-hooks/state/workers/patches/<worker_id>.patch`, and removes the
  worktree after execution. These modes require the source worktree to be
  clean so workers cannot silently miss uncommitted parent edits.
- `WorkerAggregationLive` summarizes session results and detects same-file
  write conflicts before integration. Its summary includes active/completed/
  failed worker ids, changed files, risks, blockers, an integration plan, and
  whether final verification is still required. Completed write workers that
  changed files but returned failed verification, missing verification, or no
  captured isolated patch are not ready for integration.
- `WorkerIntegrationLive` applies a selected worker patch only after
  `git apply --check` succeeds. It refuses read-only workers, incomplete runs,
  missing patches, failed worker verification, and worker-reported blockers.
  Applying a patch always reports that final verification is still required in
  the parent workspace.

## CLI / observability

`claude-hooks-workers` exposes the worker substrate without reading unbounded
state files:

- `list [--session <id>] [--limit <n>] [--json]`
- `show <worker_id> [--json]`
- `tail [--session <id>] [--limit <n>] [--json]`
- `summary --session <id> [--json]`
- `apply <worker_id> [--check] [--json]`
- `cancel <worker_id> [--reason <text>] [--json]`
- `retry <worker_id> --prompt <text> [--json]`

`retry` requires a fresh prompt because raw prompts are intentionally not
persisted. The queue still persists only redacted job payloads and the run
ledger stores only prompt hashes.

## Minimal-lift rationale

This design deliberately avoids hidden background execution in the hook layer.
The package:

- annotates worker launch prompts,
- injects context at subagent start,
- validates and records outputs at subagent stop / task completion,
- records worker lifecycle state through `WorkerRunsLive`,
- exposes a supervisor that must be called explicitly by an orchestrator or CLI,
- provides aggregation/conflict evidence plus checked patch application for final
  integration.

That is enough to enable a worker pattern while preserving the current
dispatcher architecture and test surface.
