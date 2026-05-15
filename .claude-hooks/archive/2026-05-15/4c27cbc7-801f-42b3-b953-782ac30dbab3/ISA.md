---
effort: advanced
phase: observe
---

# ISA — Auto-delegation friction

## Problem
User is annoyed that delegation to `Agent` / subagents only happens when they
explicitly say "use a subagent". The implicit ask is: change Claude's default
behavior so investigation-shaped prompts trigger delegation automatically,
without the user having to micromanage tool selection.

## Vision
Investigation-class prompts (open-ended "how does X work", "find every Y",
multi-file research) auto-route to subagents. Direct one-shot prompts continue
to use direct tools. User doesn't have to think about tool choice.

## Out of Scope
- Forcing subagent use for trivial tasks.
- Net-new hook dispatcher code if existing classifier output is sufficient.
- Removing user override — explicit "don't delegate" must still win.

## Constraints
- Must not raise latency/cost on single-step prompts.
- Must remain overridable per-turn.
- Should use existing infrastructure (classifier, memory, CLAUDE.md) before
  proposing new hook code.

## Goal
Land a behavior change so the next investigation-class prompt triggers `Agent`
delegation by default, without a "use a subagent" cue.

## Criteria
- ISC-1: Enumerate the levers (doctrine / memory / hook nudge / hard gate)
  with honest tradeoffs.
- ISC-2: Recommend the most direct lever and explain why.
- ISC-3: Offer to apply it.

## Features
- Doctrine entry in `~/.claude/CLAUDE.md` or a feedback memory file.
- Optional `UserPromptSubmit` nudge keyed to workflow classification.

## Test Strategy
- After applying the chosen lever, the next "how does X work" / "find Y" turn
  in a new session should produce an `Agent` call without a cue.

## Verification
- ISC-1: Enumerated four levers (memory / CLAUDE.md / hook nudge / hard gate)
  with tradeoffs in turn 4.
- ISC-2: Recommended lever B (global CLAUDE.md) with reasoning in turn 4.
- ISC-3: Drafted exact text, confirmed target with user, appended rule 16 to
  `/Users/eskender_archetype/.claude/CLAUDE.md` after rule 15.

---

# Addendum — PR 46 update

## Problem
User asked to pull the latest from PR 46 after a push. Two orphaned
WorkerRun records (`a8ed7e0261a9c430b`, `ad3947e4bd00edc9e`) from killed
livelocked subagents were blocking all parent writes/bash via the worker-
correlation gate.

## Goal
Cancel the stuck workers; fast-forward local to the new PR 46 tip.

## Criteria
- ISC-P1: Stuck workers in terminal state.
- ISC-P2: Local HEAD matches `origin/codex/worker-architecture-control-plane`.

## Verification
- ISC-P1: User ran `claude-hooks-workers cancel` for both runs from their
  shell while the parent session was gated. `claude-hooks-workers list`
  now reports both as `cancelled`.
- ISC-P2: `git fetch` succeeded; local HEAD `0860054` matches FETCH_HEAD
  and origin tip. No fast-forward needed — already current.
- New commit on origin: `0860054 Prevent bare subagents from entering worker
  enforcement` — fixes the SubagentStop livelock bug surfaced earlier this
  session.

phase: complete

---

# Addendum — Rate limiting audit (live test of 0860054)

## Problem
Where is rate limiting handled in `claude-hooks-ts`? Doubles as the live UX
test of the bare-subagent fix in commit 0860054.

## Goal
Cite the file(s)/line(s) implementing rate limiting; report cleanly without
livelock.

## Criteria
- ISC-R1: Subagent completes without SubagentStop livelock (fix validation).
- ISC-R2: Rate-limiting locations cited with file:line, or absence confirmed.

## Verification
(pending)

