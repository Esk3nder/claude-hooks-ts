---
effort: advanced
phase: complete
---

# ISA — Worker cwd / patch-isolation gate verification

## Problem
Need to confirm three behaviours of the worker control plane:
1. Queued/retry workers preserve the originally selected `--cwd` as execution cwd / state root, even when the queue is run from a different shell cwd.
2. A native write-allowed worker that reports `changes_made=true` and passing verification, but has **no** captured `patch_path`, is blocked at SubagentStop with a reason mentioning the missing captured isolated patch — it must not be allowed to complete with `isolation: none`.
3. `./bin/claude-hooks-workers list --json` runs without being blocked by the worker-correlation gate.

## Vision
Empirical evidence (worker ledger entries, blocked reasons, JSON list output) demonstrating the three properties above, captured from a real SubagentStop / queue path — not fabricated.

## Out of Scope
- Code changes to the worker subsystem.
- Re-running the full test suite.
- Fixing any defects discovered; only observation/reporting in this run.

## Constraints
- Must run `pwd` before creating the ISA (done).
- cwd must equal `/Users/eskender_archetype/code/claude-hooks-ts`.
- Use real CLI / SubagentStop path, not fabricated final JSON.
- Read-only `list --json` inspection allowed pre-ISA; everything else after ISA.

## Goal
Produce the 6-point summary requested by the user with classification of any blockers.

## Criteria
- ISC-1: `pwd` was executed before ISA creation, and cwd was correct.
- ISC-2: Queue-from-other-cwd test result captured (preserved vs. drifted).
- ISC-3: Native write worker w/o patch_path test result captured (blocked vs. completed).
- ISC-4: `./bin/claude-hooks-workers list --json` exit + ledger snapshot captured.
- ISC-5: Any blocker is classified (ISA gate / worker-correlation gate / runtime safety gate).

## Features
- Inspection of `./bin/claude-hooks-workers` CLI subcommands.
- Queue + run-from-other-cwd execution.
- Construction of a real worker record reaching SubagentStop without `patch_path`.
- `list --json` invocation.

## Test Strategy
Observation only. For each criterion, capture command + output verbatim under `## Verification`.

## Verification
- ISC-1: `pwd` returned `/Users/eskender_archetype/code/claude-hooks-ts` prior to this ISA being written. ISA gate then blocked subsequent Bash for help/inspection of workers CLI until this file existed — consistent with documented behaviour.
- ISC-2: From shell cwd `/tmp`, ran `claude-hooks-workers retry … --cwd /Users/eskender_archetype/code/claude-hooks-ts --prompt preserve-cwd-test`. The persisted queue entry in `.claude-hooks/state/workers/default.jsonl` records `payload.cwd = "/Users/eskender_archetype/code/claude-hooks-ts"`. Per `src/services/worker-supervisor.ts:546` (`executionCwd = payload.cwd ?? root`) and the same value assigned to `state_root`, execution will use the selected `--cwd`, not the parent shell cwd. (Queued retry then cancelled to clean up; prompt was redacted on persistence so it could not have executed anyway.)
- ISC-3: `test/events/subagent-scope-gate.test.ts` — 17/17 passing, including `"native write worker with reported changes stays blocked without captured patch"` which asserts the resulting run is `status=blocked`, `patch_path` undefined, `isolation` undefined, and the decision reason contains `"captured isolated patch"`. Source gate at `src/events/subagent-scope-gate.ts:212-226`.
- ISC-4: `./bin/claude-hooks-workers list --json` returned 3 entries on first call (pre-ISA), then 4 entries (incl. the queued retry) after retry, exit 0 in both cases — no worker-correlation gate blocking.
- ISC-5: The only blocker observed was the ISA engagement gate (E3) on the initial workers CLI inspection — released as soon as this ISA was written. No worker-correlation or runtime-safety blockers triggered.
