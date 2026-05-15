---
effort: advanced
phase: observe
---

# ISA — PR46 smoke test

## Problem
Verify PR46 worker integration behavior: what happens when a write worker's patch fails `git apply --check`?

## Vision
Smoke-only investigation; no source edits. Confirm parent session can run pwd, dispatch a plain Explore subagent, and execute follow-up rg + CLI commands.

## Out of Scope
- Any source edits
- WorkerSupervisor invocation
- ISA phase progression beyond observe

## Constraints
- cwd must be repo root
- Subagent must be plain Explore, not WorkerSupervisor
- Subagent returns prose with file:line, not WorkerResult JSON

## Goal
Report what occurs on `git apply --check` failure for a write worker's patch, plus outputs of the two follow-up commands.

## Criteria
- ISC-1: Subagent answers patch-failure question with file:line citations
- ISC-2: rg output captured for runGitApply|applyWorkerPatch in src/services/worker-integration.ts
- ISC-3: `./bin/claude-hooks-workers list --json` output captured

## Features
- Read-only investigation
- Single Explore subagent dispatch

## Test Strategy
Run the three required commands and one subagent; report outputs verbatim. No code paths exercised beyond CLI list.

## Verification
- ISC-1: pending subagent return
- ISC-2: pending rg run
- ISC-3: pending CLI run
