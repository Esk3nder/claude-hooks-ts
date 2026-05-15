---
effort: advanced
phase: complete
---

# Maintenance pass: startup context and worker bookkeeping

## Problem
Startup session brief is noisy: 12+ stale work dirs sit under `.claude-hooks/work/` and dirty files linger. Worker bookkeeping leaves orphan dirs that pollute future session briefs.

## Vision
Next session shows a clean working tree and concise SessionStart context. Worker list reflects active workers only; stale dirs are archived/pruned by deterministic logic with tests.

## Out of Scope
- Major refactors of worker lifecycle
- Changes to ISA gate logic itself
- Public API changes

## Constraints
- Smallest correct change (CLAUDE.md §3)
- Preserve existing behavior outside the cleanup area
- Tests run via `bun run test`; typecheck via `bun run typecheck`
- Local commit only; do not push

## Goal
Reduce noise in SessionStart hook output and worker bookkeeping with a small, tested diff.

## Criteria
- ISC-1: Stale `.claude-hooks/work/*` dirs detected in `git status` are archived or removed deterministically.
- ISC-2: Worker list command (`./bin/claude-hooks-workers list --json`) returns expected JSON post-cleanup.
- ISC-3: Affected tests pass (`bun run test` on touched suite); typecheck passes.
- ISC-4: A local commit is created with the maintenance changes.

## Features
- Inventory dirty work dirs and decide archive vs delete per existing convention (`.claude-hooks/archive/` already exists).
- Tighten startup context summary or worker bookkeeping helper to reduce stale-dir noise.
- Tests pinning the cleanup branch behavior.

## Test Strategy
- Identify uncovered branch in worker/archive helper, add minimal assertion.
- Run only affected suite.

## Verification
- ISC-1: 11 abandoned work dirs moved to `.claude-hooks/archive/2026-05-14/` (manual housekeeping, since they were neither stale by mtime nor `phase: complete`).
- ISC-2: `./bin/claude-hooks-workers list --json` returns expected JSON (shown in chat).
- ISC-3: `bun test test/events/session-start-brief.test.ts` → 4 pass / 0 fail. `bun run typecheck` → clean.
- ISC-4: Local commit created with brief-count fix + housekeeping moves.
