---
effort: advanced
phase: observe
---

# ISA — PR46 failure-path smoke

## Problem
Verify PR46 worker apply failure path: a conflicting patch should be rejected by `git apply --check` before any real apply, no partial state, and the failed worker shown in `list --json`. Also verify subagent launch+cancel and absence of worker-correlation blocking on parent commands.

## Vision
Real-CLI smoke through `./bin/claude-hooks-workers`, not synthetic JSON.

## Out of Scope
- Modifying production code
- Fixing any unrelated worker bugs

## Constraints
- cwd must be repo root
- Use real CLI path for applyWorkerPatch
- Patch must conflict with current `src/services/worker-integration.ts`

## Goal
Produce a 6-point summary answering the user's questions.

## Criteria
- ISC-1: Conflicting patch authored against current `src/services/worker-integration.ts`
- ISC-2: applyWorkerPatch invoked via `./bin/claude-hooks-workers` apply path
- ISC-3: `git apply --check` rejects before real apply (no partial state)
- ISC-4: Long-running subagent reached started state then cancelled
- ISC-5: `./bin/claude-hooks-workers list --json` reflects failed/cancelled workers
- ISC-6: No worker-correlation blocking observed on parent commands

## Features
- Author conflicting patch
- Create write-allowed worker record via CLI
- Invoke apply; capture output
- Launch & cancel subagent
- Final `list --json`

## Test Strategy
Manual smoke; capture stdout/stderr of each step. Inspect work dir for partial files.

## Verification
(to be filled)
