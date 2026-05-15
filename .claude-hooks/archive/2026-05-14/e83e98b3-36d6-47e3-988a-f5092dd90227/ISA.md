---
effort: advanced
phase: observe
---

# ISA: PR46 bare-subagent smoke

## Problem
Smoke-test from repo root that bare Explore subagents and worker CLI inspection are not trapped by worker enforcement.

## Vision
Confirm gate behavior on read-only investigation flow.

## Out of Scope
- Editing source files
- Changing worker integration behavior

## Constraints
- Read-only; no source edits.
- Run the exact commands the user specified.

## Goal
Answer "what happens if a write worker's patch fails git apply --check?" and run the two follow-up commands.

## Criteria
- ISC-1: Subagent answer delivered with file:line references.
- ISC-2: rg command executed and output reported.
- ISC-3: `./bin/claude-hooks-workers list --json` executed and output reported.

## Features
- Bare Explore subagent inspection of worker-integration.ts.
- Parent-session rg + CLI invocations.

## Test Strategy
Manual: observe command outputs in transcript.

## Verification
- ISC-1: Explore subagent returned prose with citations to src/services/worker-integration.ts (lines 132-164, 251-295) — done above.
- ISC-2: pending command run.
- ISC-3: pending command run.
