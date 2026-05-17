---
effort: advanced
phase: observe
---

# ISA

## Problem
Read-only smoke test requested by user: verify cwd, delegate Explore subagent to answer "what happens if a write worker's patch fails `git apply --check`?", then run two specific commands.

## Vision
Successful smoke test output back to user.

## Out of Scope
Any file edits beyond this ISA. No code changes.

## Constraints
- No file edits.
- Subagent must be Explore (read-only) and return prose with file:line refs, not WorkerResult JSON.

## Goal
Execute the three steps the user specified and report results.

## Criteria
- ISC-1: cwd verified equal to /Users/eskender_archetype/code/claude-hooks-ts
- ISC-2: Explore subagent answers the git-apply-check failure question with file:line refs
- ISC-3: `rg -n "runGitApply|applyWorkerPatch" src/services/worker-integration.ts` executed and output reported
- ISC-4: `./bin/claude-hooks-workers list --json` executed and output reported

## Features
N/A (read-only smoke test).

## Test Strategy
Direct command execution; no automated tests added.

## Verification
- ISC-1: pending pwd output
- ISC-2: pending subagent return
- ISC-3: pending rg output
- ISC-4: pending bin command output
