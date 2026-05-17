---
effort: advanced
phase: complete
---

# ISA: PR46 live SubagentStop patch-isolation smoke

## Problem
Verify that the live SubagentStop handler correctly transitions a write-allowed native subagent run to a blocked status when no patch_path/isolation is set, by exercising the actual hook code path end-to-end (not a manual ledger mutation).

## Vision
A reproducible smoke run from repo root demonstrating: ledger entry created → SubagentStop handler invoked with realistic agent output JSON → handler observes the missing patch/isolation on a write-allowed run and blocks it → `claude-hooks-workers list --json` reflects the handler-applied state.

## Out of Scope
- Modifying production handler code
- Refactoring ledger schema
- Touching unrelated workers/sessions
- Changing ISA gate logic

## Constraints
- Run from `/Users/eskender_archetype/code/claude-hooks-ts`
- Use real WorkerRuns ledger entry (not synthetic)
- Use real SubagentStop hook code path (not direct status writes)
- Session/agent identifiers are fixed:
  - session_id = `pr46-live-subagent-stop`
  - agent_id = `agent-write-no-patch`
  - agent_type = `general-purpose`
  - mode = `write-allowed`
  - status = `running` (initial), no patch_path, no isolation
- Handler input: changes_made (1 file), verification (1 passed), blockers `[]`, confidence `high`
- Final inspection: `./bin/claude-hooks-workers list --json`

## Goal
Produce evidence on disk that the SubagentStop handler — invoked through the canonical entry point — blocks a write-allowed subagent that reports changes without patch isolation.

## Criteria
- ISC-1: Ledger entry exists with the specified identifiers and initial running/no-patch state before handler invocation.
- ISC-2: SubagentStop handler is invoked through the live code path (CLI/dispatch), not by editing the ledger row directly.
- ISC-3: After handler runs, the ledger row's status is `blocked` (handler-applied), not via direct edit.
- ISC-4: `./bin/claude-hooks-workers list --json` output is captured and shows the blocked state.

## Features
- Locate WorkerRuns ledger insert API and SubagentStop entry point
- Insert ledger row
- Build SubagentStop payload and dispatch
- Capture list output

## Test Strategy
- Inspect ledger JSON before & after handler invocation
- Compare status field transition: running → blocked
- Confirm `claude-hooks-workers list --json` shows the row blocked

## Verification
- ISC-1 (ledger inserted, running, no patch): `insert.ts` used `WorkerRuns.createQueued` + `markRunning` → row `pr46-live-subagent-stop:agent-write-no-patch` was `status:"running"`, `mode:"write-allowed"`, no `patch_path`, no `isolation` (script stdout captured).
- ISC-2 (live handler invoked): `./bin/claude-hook SubagentStop < /tmp/sastop.json` ran the real dispatcher → handleSubagentStop → recordWorkerStop path; returned `{"decision":"block","reason":"write worker reported changes without a captured isolated patch"}` — that reason is emitted only by `src/events/subagent-scope-gate.ts:223` (write-allowed branch with no `run.patch_path`).
- ISC-3 (handler-applied blocked status): `./bin/claude-hooks-workers list --json` final row shows `status:"blocked"`, `blocked_reason:"write worker reported changes without a captured isolated patch"`, `stopped_at` set by handler — not by the insert script.
- ISC-4 (CLI inspection): `./bin/claude-hooks-workers list --json` ran cleanly and emitted the row.

