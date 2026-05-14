# Subagent UX Follow-ups (post PR 46)

**Context for coding agent:** PR 46 (`codex/worker-architecture-control-plane`, head `0860054`) fixed one of four related bugs in the worker control plane. Three follow-ups remain. They were discovered live during a Claude Code session in this repo when the user attempted to delegate ordinary research questions to subagents.

The fixed bug for context (do not redo): `SubagentStop` previously enforced strict `WorkerResult` JSON on *every* subagent, including bare `Explore` / `general-purpose` agents launched directly by the model. Bare subagents have no awareness of the contract, returned prose like `"Halting."`, were rejected by the Stop hook, and Claude Code re-invoked them — producing an unbounded livelock. Commit `0860054` ("Prevent bare subagents from entering worker enforcement") restricts `WorkerResult` enforcement to subagents launched with the worker-contract marker. See `src/events/subagent-scope-gate.ts` and `test/events/subagent-scope-gate.test.ts`.

## Bug A — Killed subagents leave WorkerRun records in non-terminal state, shrapneling the parent

### Symptom

When a subagent is killed externally (user `Ctrl-C`, `TaskStop`, parent timeout), its `WorkerRun` record remains in `running` / `blocked` state. The package's correlation gate (`src/policies/worker-permissions.ts`, enforced via `PreToolUse`) then blocks **all** non-allowlisted Bash and all Write-capable tools (`Edit`, `Write`, `MultiEdit`) in the parent session with the message:

> `Write-capable tool Edit had no worker correlation while active workers exist in this session.`
> `Bash had no worker correlation while active workers exist; only allowlisted read-only inspection commands are allowed.`

The parent is stuck until the user manually runs `claude-hooks-workers cancel <id>` from a separate shell.

### Repro

1. Launch any subagent (via `Task` / `Agent`) that won't terminate cleanly on its own (e.g., pre-`0860054` livelock, or an externally killed agent).
2. From the parent, attempt any `Edit` or non-allowlisted `Bash`.
3. Observe the worker-correlation gate refuse.
4. Confirm `claude-hooks-workers list` shows the run still in `running` / `blocked`.

### Root cause hypothesis

`SubagentStop` updates the `WorkerRun` lifecycle to `completed` / `failed` / `blocked` based on the agent's return payload. There is no codepath that fires when the agent is killed *before* `SubagentStop` runs — so the record never reaches a terminal state.

### Acceptance criteria

- When a subagent is killed externally, its `WorkerRun` transitions to `cancelled` automatically.
- Mechanism options to evaluate:
  - A `TaskStop`/`SubagentKilled` hook handler (if Claude Code emits one).
  - A periodic supervisor sweep that marks runs older than `lastHeartbeat + N` seconds as `cancelled`.
  - A correlation-gate-side fallback: when the gate fires, if the blocking run has no heartbeat in >N seconds, auto-cancel and release.
- The parent session must be able to recover without leaving Claude Code.
- Add a test in `test/services/worker-runs.test.ts` (or `worker-supervisor.test.ts`) that simulates an abandoned run and asserts auto-cancellation.

## Bug B — `claude-hooks-workers cancel` CLI is itself blocked by the gate it exists to clear

### Symptom

When the parent is locked by Bug A, the obvious user remediation is the package's own CLI:

```bash
./bin/claude-hooks-workers cancel <id> --reason "killed"
```

This command is also blocked by the worker-correlation gate, since `./bin/claude-hooks-workers` is not on the allowlist. The user must open a *separate* shell outside Claude Code to run it. The package's escape hatch is unreachable from within the failure mode it's designed to address.

### Repro

1. Trigger Bug A.
2. Inside Claude Code, run `./bin/claude-hooks-workers cancel <id>`.
3. Observe the gate refuse: `Bash had no worker correlation while active workers exist; only allowlisted read-only inspection commands are allowed.`

### Acceptance criteria

The worker-correlation gate must allow the package's own CLI through unconditionally. Specifically:

- `./bin/claude-hooks-workers list` (any subcommand) — always allowed.
- `claude-hooks-workers list` (via PATH) — always allowed.
- `bun run scripts/workers.ts ...` — allowed when the script path matches.

This belongs in the allowlist in `src/policies/worker-permissions.ts`. The fix is small but the test surface matters: add a case to `test/policies/worker-permissions.test.ts` proving `claude-hooks-workers` subcommands bypass the gate even when active workers exist.

## Bug C — Read-only subagent permission scope is too narrow for the agent to do useful research

### Symptom

After Bug A is fixed and a bare subagent launches cleanly, the agent's `Bash` is still gated such that it cannot run `find` or `grep`. From a live test in this session, the `Explore` agent returned in 12 seconds with:

> "I cannot proceed further with the permission allowlist configuration because I'm blocked from accessing the filesystem and transcripts. ... I need `Bash(find *)` and `Bash(grep *)` permissions to scan the codebase."

The Explore agent is *defined* to have full read-only tool access — including Bash. The package's permission policy is overriding that, classifying bare subagents as `read-only` workers and stripping their search capability. Result: delegated research is impossible.

### Acceptance criteria

- A bare `Explore` agent (no worker-contract marker) launched from a parent Claude Code session must be able to run `find`, `grep`, `ls`, `cat`, and other read-only inspection commands.
- The current correlated-`PreToolUse` rule that strips Bash from read-only workers should apply **only** to opted-in workers — identified by the same marker mechanism `0860054` uses to scope `SubagentStop` enforcement.
- Bare subagents inherit Claude Code's default permission set without package interference.
- Likely files: `src/policies/worker-permissions.ts`, `src/events/pre-tool-use.ts` (or wherever correlation is enforced).
- Tests in `test/policies/worker-permissions.test.ts`: a case proving a bare subagent (no marker) can run `Bash(grep ...)`, and a case proving a marked read-only worker is still blocked.

## Cross-cutting

The three bugs share a root: **the worker control plane was implemented as an always-on policy that doesn't distinguish opted-in workers from bare subagents.** Commit `0860054` introduced the marker-based discrimination for `SubagentStop`. Apply the same discrimination consistently to:

- the correlation gate (Bug A / B)
- the read-only worker permission scope (Bug C)

The marker is the single source of truth for "this subagent is a contracted worker"; nothing should enforce the worker contract on subagents without it.

## Suggested PR ordering

1. **Bug B first** (smallest, unblocks user remediation for everything else).
2. **Bug C** (restores delegated research; uses the same marker pattern as `0860054`).
3. **Bug A** (largest, requires lifecycle work; lower urgency once B unsticks users).

Each as a separate PR, each with the same docstring discipline as `0860054` (Constraint / Rejected / Confidence / Scope-risk / Directive / Tested / Not-tested).
