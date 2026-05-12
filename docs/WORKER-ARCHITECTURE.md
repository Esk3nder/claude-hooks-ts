# Worker Architecture

`claude-hooks-ts` does not spawn worker agents itself. Instead, it uses the
existing hook surface as a control plane around worker-style `Task` / `Agent`
launches and subagent lifecycle events. This keeps the lift small: the harness
still owns execution, while this package adds scope, evidence, and integration
contracts.

## Control points

1. `PreToolUse` for `Task` / `Agent`
   - Rewrites the launch prompt once with a worker contract marker.
   - Preserves the caller's existing tool input fields.
   - Does not block valid launches.

2. `SubagentStart`
   - Injects role-specific scope rules into the worker context.
   - Adds a role-specific output contract so the worker returns integrable
     results instead of free-form chatter.

3. `SubagentStop`
   - Requires investigative workers to return concrete evidence.
   - Evidence must include an anchor such as `file:line` or a command plus
     confidence / next-action / risk language.

4. `TaskCompleted`
   - Requires acceptance criteria and non-empty evidence before a task can be
     marked complete.
   - Continues to consult active ISA verification when present.

5. `TeammateIdle`
   - Blocks idle handoff when files changed but verification has not passed.

## Worker output contract

Workers are asked to return:

- `summary`
- `files_relevant`
- `changes_made`
- `commands_run`
- `verification`
- `risks`
- `blockers`

The orchestrator remains responsible for reconciling the result, rerunning the
right checks, and deciding whether to integrate changes.

## Minimal-lift rationale

This design deliberately avoids a new process supervisor, queue, database, or
custom worker runtime. The package only:

- annotates worker launch prompts,
- injects context at subagent start,
- validates outputs at subagent stop / task completion,
- records existing lifecycle state through the current session-state service.

That is enough to enable a worker pattern while preserving the current
dispatcher architecture and test surface.
