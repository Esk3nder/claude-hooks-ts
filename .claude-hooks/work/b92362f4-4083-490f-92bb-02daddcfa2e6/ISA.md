---
effort: advanced
phase: complete
---

# Maintenance pass: startup context and worker bookkeeping

## Problem
SessionStart brief reported a `Dirty files: N` count that double-counted work-dir entries that were then collapsed in the summary, making the headline misleading. Untracked `.claude-hooks/work/*` ISAs without `phase: complete` accumulated and added noise.

## Vision
Brief headline count matches what's actually shown; abandoned work dirs are archived.

## Out of Scope
- Worker lifecycle / queue changes
- ISA gate logic itself

## Constraints
- Smallest correct change
- Preserve existing behavior outside the cleanup

## Goal
Make the next session brief easier to scan.

## Criteria
- ISC-1: Abandoned work dirs archived under `.claude-hooks/archive/2026-05-14/`.
- ISC-2: `claude-hooks-workers list --json` works (reported in chat).
- ISC-3: Affected test suite passes; typecheck clean.
- ISC-4: Local commit created.

## Features
- `Dirty files` count now reflects the post-collapse list; append `(+N work dir entries collapsed)` when relevant.

## Test Strategy
Updated `test/events/session-start-brief.test.ts` expected string for the work-dir summary case to assert the new headline format.

## Verification
- ISC-1: 11 work dirs moved to `.claude-hooks/archive/2026-05-14/`.
- ISC-2: `./bin/claude-hooks-workers list --json` succeeded (output shown in chat).
- ISC-3: `bun test test/events/session-start-brief.test.ts` → 4 pass / 0 fail; `bun run typecheck` → clean.
- ISC-4: Local commit created on `codex/worker-architecture-control-plane`.
