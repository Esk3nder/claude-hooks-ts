---
effort: advanced
phase: observe
---

## Problem
`applyWorkerPatch` in `src/services/worker-integration.ts` lacks a JSDoc describing its error contract. Callers must read the body to learn which errors it returns.

## Vision
A single-line JSDoc above `applyWorkerPatch` documents the error contract surface (`WorkerRunError` for git-apply / rollback / preconditions, `EventStoreError` from `markIntegrated`).

## Out of Scope
- Refactoring the function body
- Changing rollback semantics
- Touching other worker-integration helpers

## Constraints
- Throwaway branch only; do not push
- Edit a single source line (JSDoc comment) — no behavior change
- Must still pass `bun run typecheck`

## Goal
Add a one-line JSDoc above `applyWorkerPatch` and commit on a throwaway branch.

## Criteria
- ISC1: A `/** ... */` JSDoc line precedes the `applyWorkerPatch` declaration in `src/services/worker-integration.ts`.
- ISC2: A new commit on a throwaway branch contains exactly that change.
- ISC3: `./bin/claude-hooks-workers list --json` runs successfully from repo root.

## Features
- One-line JSDoc above `applyWorkerPatch`.

## Test Strategy
- Visual diff inspection (`git show`) confirms the JSDoc was added.
- `./bin/claude-hooks-workers list --json` exits 0 and prints JSON.

## Verification
- ISC1: pending — confirmed after Edit via `git diff`.
- ISC2: pending — confirmed after commit via `git log -1`.
- ISC3: pending — confirmed after CLI run.
