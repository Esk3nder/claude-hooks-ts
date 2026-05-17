# Subagent UX Fixes

PR 46 fixes the live failure mode where worker-control-plane policies leaked
onto ordinary Claude Code subagents and then locked the parent session after the
subagents were killed.

## Fixed Behaviors

- Bare subagents without the worker-contract marker are not treated as workers.
  Their `PreToolUse` events pass through when no matching `WorkerRun` exists, so
  delegated research can still use normal read-only inspection commands such as
  `grep`, `find`, `cat`, and `ls`.
- Contracted workers still use the stricter worker policy. A marked read-only
  worker cannot write files or run non-allowlisted Bash.
- The package's own worker CLI bypasses the active-worker correlation gate:
  `claude-hooks-workers ...`, `./bin/claude-hooks-workers ...`, and
  `bun run scripts/workers.ts ...` remain available to inspect or cancel worker
  state from inside Claude Code.
- Contracted workers that stop without output are marked `cancelled` instead of
  `blocked`, and the stop hook does not re-prompt them for structured JSON.
- Legacy blocked runs with the old missing-output reason are auto-cancelled the
  next time the parent correlation gate evaluates them, allowing the parent
  session to recover without leaving Claude Code.

## Marker Boundary

The worker-contract marker is the single discrimination point:

- `SubagentStart` creates a `WorkerRun` only for marked launches.
- `SubagentStop` enforces `WorkerResult` JSON only for runs present in the
  worker ledger or launches recorded with the marker.
- `PreToolUse` enforces worker scope only when the tool event correlates to an
  active `WorkerRun`. A bare `agent_id` / `task_id` with no run is left to
  Claude Code's normal permission system.

## Regression Coverage

- `test/events/worker-runtime-integration.test.ts`
  - no-output contracted workers become `cancelled`;
  - old missing-output blocked runs are cancelled on gate evaluation;
  - parent tools are no longer locked after cancellation.
- `test/policies/worker-permissions.test.ts`
  - package worker CLI commands bypass the gate while active workers exist;
  - bare subagent `Bash(grep ...)` passes through with no `WorkerRun`;
  - marked read-only workers remain constrained.
