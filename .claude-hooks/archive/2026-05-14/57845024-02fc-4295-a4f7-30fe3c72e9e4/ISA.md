---
effort: advanced
phase: observe
---

# ISA: rewrite README from first principles

## Problem
The current README is 232 lines, accurate but understated. PR #41's attempted rewrite reintroduces PAI framing that main has intentionally dropped. A fresh README is needed that (a) leads with what the reader gets, (b) explains why this exists in problem-first terms, (c) shows concrete examples — using main's actual terminology, not PAI legacy framing.

## Vision
A README that a user with the problem ("I want my Claude Code sessions to be safer / more verifiable / less wasteful") can read in three minutes and know whether to install. The doc layers from answer → why → example. No PAI-era framing; the project's own vocabulary throughout.

## Out of Scope
- Generating tutorials beyond installation + one usage example.
- Rewriting `docs/HOOK-EVENTS.md` or other docs.
- API reference material; that lives in code.

## Constraints
- Use current main's terminology (ISA, ISC, classifier, dispatcher, engagement gate) — no "PAI Algorithm primitive" framing.
- Every claim about features must be verifiable against the actual codebase. Do not invent features.
- Markdown only, no emoji unless they already appear in current README.
- Land via feature branch + PR (the right git workflow), not a direct main push.

## Goal
Replace `README.md` with a new version that follows the answer-why-example arc and accurately describes the current codebase.

## Criteria
- [ ] ISC-1 — PR #41 closed (superseded by this rewrite); branch `chore/m17-readme` deleted on origin.
- [ ] ISC-2 — Codebase research summary captures: actual feature list (with file:line evidence), all CLI binaries in `bin/`, every event handled in `src/events/`, and the canonical glossary (ISA, ISC, mode, tier, engagement gate, dispatcher).
- [ ] ISC-3 — New README leads with **the answer** (what you get in 1–2 sentences), then **the why** (the problem), then **the example** (install + verify).
- [ ] ISC-4 — Every feature claim cross-references real code or commands (no hypothetical features).
- [ ] ISC-5 — No occurrences of "PAI" or "Algorithm primitive" framing in the new README.
- [ ] ISC-6 — Feature branch pushed, PR opened against main.

## Features
- F1 — Close & clean up PR #41.
- F2 — Research current state of codebase (Explore agent or direct).
- F3 — Draft README; replace existing file.
- F4 — Open PR.

## Test Strategy
- ISC-2: visual cross-check: every feature in the README maps to a file path in `src/`.
- ISC-5: `grep -i "pai\|primitive" README.md` returns 0 substantive matches.
- ISC-6: `gh pr view` returns the new PR URL.

## Verification
(filled per ISC)
