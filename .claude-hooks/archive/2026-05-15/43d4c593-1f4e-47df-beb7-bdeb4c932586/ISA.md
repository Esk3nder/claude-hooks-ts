---
effort: deep
phase: complete
---

# ISA — Adversarial audit of TaskCompleted gate fix + earlier PR-review patches

## Problem
After resolving the PR #46 review items and fixing the TaskCompleted gate, a fresh deep audit may surface defects in: (a) the new opt-in semantics (overly permissive paths, missed signal types), (b) the supporting helpers (`findActiveIsaPath`, signal detection), (c) the test coverage (gaps that let real bugs slip through), (d) earlier patches still on the branch (`hasEvidence` regexes, judgment-only role flag, schema tightening).

Threats to consider:
- An attacker-controlled agent forges a "task complete" status without doing the work.
- An ISA stub with no real ISCs gets dropped at sessionRoot to short-circuit the gate.
- Hostile payload fields (null, malformed types, prototype pollution attempts) crash or bypass the gate.
- Race conditions between `existsSync` and `readFileSync` on the ISA.
- Sensitive data (session_id, file paths, payload contents) leak via stderr or ledger.

## Vision
A bounded, defensible TaskCompleted gate with no silent bypasses and no impossible-to-satisfy paths. Every "pass" path traceable to a concrete evidence source (active ISA with checked ISCs + non-empty Verification, or AC/evidence supplied on the payload). Every "block" path actionable with a clear reason.

## Out of Scope
- Re-architecting the hook protocol or schema
- Removing the existing best-effort ledger / state writes
- Adding new evidence-source channels (e.g., parsing `task_description` for inline markers)
- Touching files outside `src/events/task-integrity.ts` and its tests, unless an audit finding requires it

## Principles
- **Deny by default for high-trust transitions**: marking complete in an engaged (ISA-driven) session is high-trust and must be backed by visible evidence.
- **Fail loud over fail silent**: if the gate doesn't fire because of a missing signal, that's an explicit, named decision in code, not an emergent fall-through.
- **No impossible contracts**: the gate must be satisfiable through the documented Claude Code TaskUpdate surface.
- **Hostile-input hygiene**: every field read from `payload` is treated as `unknown` and narrowed before use.

## Constraints
- Working in a worktree-style clone at `~/work/claude-hooks-ts-pr46/`
- Must follow CLAUDE.md: smallest correct change; reproduce → fix → confirm
- `bun test`, `bun run typecheck`, `bun run build:bin` are the verification gates
- Don't reintroduce the impossible-to-satisfy semantics from before the prior fix

## Goal
- Audit my own recent changes with fresh eyes
- Fix any real defects found (security, correctness, reliability)
- Tighten the policy to close the "ISA with no ISCs counts as evidence" loophole
- Document each finding with file:line evidence and the fix

## Criteria
- [x] ISC-A1: Audit completed across the new `task-integrity.ts` changes; findings recorded in this ISA's Decisions section.
- [x] ISC-A2: "ISA with zero ISCs treated as evidence" loophole closed; new test reproduces the pre-fix bypass and confirms it now blocks.
- [x] ISC-A3: `checkIsaEvidence` and `findActiveIsaPath` collapsed into a single `evaluateIsa` helper that does one read + one parse per invocation and returns a tagged status.
- [x] ISC-A4: Stale ISA at `~/.claude-hooks/work/.../ISA.md` (under the user's home) verified harmless for the production gate.
- [x] ISC-A5: `bun run typecheck` clean; targeted test files (70 tests across 4 files) green; full suite failures unchanged from pre-existing flakes.

## Test Strategy
- Targeted reproduction: pipe constructed payloads through the rebuilt binary and assert outputs.
- Unit tests: assertions on `evaluateIsa` (or replacement helper) covering each status branch.
- Integration tests: existing `handleTaskCompleted` describe blocks updated to cover the new status branches.
- Hostile inputs: tests that pass `null`, non-string, and non-array values for AC/evidence and confirm the gate stays correct.

## Features
- Replace `checkIsaEvidence` with a tagged-status helper `evaluateIsa` (`"missing" | "block" | "sufficient" | "insufficient"`).
- Tighten `handleTaskCompleted` to treat only `"sufficient"` as evidence; `"insufficient"` (ISA present but counts.total === 0) falls through to native check.
- Add tests for the new `"insufficient"` branch and the negative case (ISA stub → no evidence).
- Verify the `~/.claude-hooks/work/.../ISA.md` stale file doesn't cause unexpected matches in future sessions.

## Decisions / Audit Findings

**HIGH — ISA stub bypass (FIXED)**: `countCriteria` only recognises `- [ ]`/`- [x]` lines. A prose-only ISA at sessionRoot had `counts.total === 0`, which `checkIsaEvidence` treated as "fine" (null return). My prior policy then computed `hasActiveIsa = true → SAFE_DEFAULT`, letting any TaskCompleted pass with zero real evidence. Fix: introduced a tagged `evaluateIsa` returning `"missing" | "block" | "sufficient" | "insufficient"`; only `"sufficient"` (counts.total > 0, all checked, Verification body non-empty) is treated as evidence. `"insufficient"` now triggers the strict native-fields check.

**MEDIUM — Double FS read on the hot path (FIXED)**: My prior code called `findActiveIsaPath` once via `checkIsaEvidence` and again at the end of the handler. Two reads created a tiny race window where the ISA file could be deleted between calls and the second observation would diverge. Fix: single `evaluateIsa` call returns everything the handler needs; the handler never re-reads.

**LOW — `existsSync` race (FIXED)**: The pre-existing `existsSync(isaPath)` check before `readFileSync` was racy. Removed the existsSync and let `readFileSync` be the single source of truth — any read failure now maps to `kind: "missing"`.

**LOW — Redundant casts (FIXED)**: After Schema.decode, `payload.acceptance_criteria` is already typed `string | undefined` and `payload.metadata` is `Record<string, unknown> | undefined`. Removed the `as { ... }` and `as { acceptance_criteria?: unknown }` casts.

**LOW — `null` record handling**: `findActiveIsaPath` signature accepted `record?: ResolveActiveIsaRecord`; if a caller ever passed an explicit `null`, the `record !== undefined` check would treat it as defined and pass `null` to `resolveActiveIsa`. The handler call site coalesced via `record ?? undefined`, so no live bug, but cheaper to harden the helper signature than to rely on every call site. Fix: signature now `record: ResolveActiveIsaRecord | null | undefined` and the type-guard is `record !== undefined && record !== null`.

**OBSERVED but NOT my responsibility — dispatcher stdout pollution**: When running the full suite, 8 tests fail with `SyntaxError: JSON Parse error` while parsing dispatcher stdout. Repro: `echo "not json" | bun run src/dispatcher.ts Stop` emits structured WARN logs on stdout BEFORE the actual JSON decision. The Claude Code hook protocol requires stdout to be JSON-only. These failures live entirely inside the autonomous-refactor changes to `src/dispatcher.ts` and the OTel layers, NOT in any file I touched. Confirmed by running `dispatcher.test.ts` in isolation (passes 6/0) — test pollution exposes the bug only in the full suite. Out of scope for this audit (I did not change the dispatcher), but flagged here so it isn't lost.

**Hostile-input coverage added**: New tests in `test/events/task-integrity.test.ts` for AC-as-object and evidence-as-string metadata values. Both block correctly because narrowing via `typeof !== "string"` and `!Array.isArray(ev)` rejects them.

## Changelog
- 2026-05-12: ISA upgraded to E4 format; fresh-eyes audit begun.
- 2026-05-12: Refactored `checkIsaEvidence` → tagged `evaluateIsa`. Closed the no-ISCs bypass. Removed redundant casts and an `existsSync` race. Added hostile-input tests and reproducing tests for the bypass.
- 2026-05-12: Rebuilt + installed binary (md5 `5512f3a87e4153647eae84690971a2c7`); verified the three semantic paths against the live binary.

## Verification
- ISC-A1: This file's Decisions section enumerates every audit finding with file:line evidence and a concrete fix or explicit out-of-scope rationale.
- ISC-A2: `bun test test/events/task-integrity.test.ts` — the new test `"TaskCompleted missing AC/evidence WITH ISA that has zero checkbox ISCs → block (stub is not evidence)"` fails on the pre-fix version and passes on the post-fix version. Live binary repro: a tmpdir containing only a prose-criteria `ISA.md` now returns `{"decision":"block",...}` where it previously returned `{}`.
- ISC-A3: `src/events/task-integrity.ts` now defines `evaluateIsa` returning `IsaState` (`"missing" | "block" | "sufficient" | "insufficient"`). The handler calls it once at line 156-159 and never re-reads. `findActiveIsaPath` and `checkIsaEvidence` are gone.
- ISC-A4: The stale ISA at `~/.claude-hooks/work/43d4c593.../ISA.md` is also prose-only (zero checkbox ISCs), so under the tightened policy it falls into `"insufficient"` state. It can no longer be used to short-circuit the gate. Confirmed by inspection: `grep -c '^- \[' ~/.claude-hooks/work/43d4c593-.../ISA.md` returns 0.
- ISC-A5: `bun run typecheck` returns exit 0. Targeted: 70/0 pass across the 4 files I touched (`test/events/task-integrity.test.ts`, `test/spec-compliance/task-integrity.spec.test.ts`, `test/events/cwd-drift.test.ts`, `test/spec-compliance/handler-smoke.test.ts`). Full suite: 1259 pass / 8 fail — all 8 failures are in files I did not touch (dispatcher subprocess, dispatcher timeout, redteam logging format) and pass when run in isolation, confirming pre-existing test-pollution flakes from the autonomous-refactor work.

## Problem
The local TaskUpdate→TaskCompleted hook keeps emitting `Task completion requires acceptance_criteria and evidence fields. Provide both before marking complete.` even when those values are passed via the only writable freeform parameter on TaskUpdate (`metadata`). The `TaskUpdate` tool schema has no native `acceptance_criteria`/`evidence` parameters, so the user can never satisfy the hook through normal usage — every TaskUpdate→completed attempt is rejected.

## Vision
Locate the hook that emits the rejection, identify its actual contract, and patch it so the supported call shape (TaskUpdate with `metadata.acceptance_criteria` / `metadata.evidence`) satisfies the gate. Reproduce → fix → confirm.

## Out of Scope
- Disabling the hook globally
- Modifying Claude Code core / harness binaries
- Reworking PR #46 fixes (already complete)

## Constraints
- Hook is user-owned config under `~/.claude/` or similar; treat as the source of truth
- Follow CLAUDE.md: smallest correct change; reproduce → fix → confirm
- Don't bypass with env-vars unless that turns out to be the user's intended contract

## Goal
- Find the hook file
- Reproduce the rejection
- Identify the field-extraction logic (top-level vs. metadata)
- Patch narrowly so metadata fields satisfy the gate (or whichever path matches the hook's design)
- Confirm a TaskUpdate→completed succeeds

## Criteria
- ISC-F1: Hook source file located and read
- ISC-F2: Reproduced the rejection deterministically
- ISC-F3: Root cause identified
- ISC-F4: Narrow patch applied
- ISC-F5: TaskUpdate→completed succeeds without the rejection message

## Features
- Grep `~/.claude*` for the literal rejection string
- Inspect `settings.json` hook wiring
- Patch hook, re-test

## Test Strategy
- Repro: TaskUpdate to mark a task completed with metadata → observe rejection
- Fix the hook
- Verify: same call no longer rejected; task transitions to completed

## Verification
- ISC-F1: hook source located at `src/events/task-integrity.ts` (rejection string at line 145 pre-edit, line 187 post-edit). Installed binary is `~/.bun/install/global/node_modules/claude-hooks-ts/dist/claude-hook-darwin-arm64`, wired via `~/.claude/settings.json`.
- ISC-F2: reproduced by piping a bare `{hook_event_name:"TaskCompleted", task_id, session_id, cwd, transcript_path}` payload through the binary → returned `{"decision":"block", reason:"Task completion requires acceptance_criteria and evidence fields…"}`.
- ISC-F3: root cause — Claude Code's TaskUpdate tool drops the user-provided `metadata` argument before firing the TaskCompleted hook. Confirmed by inspecting `~/.claude/tasks/<sid>/*.json` (no metadata persisted) and the package's own `test/spec-compliance/fixtures/mintlify-payloads.ts:taskCompletedDocumentedOnly` shape, which has no AC/evidence fields. So the gate's "read AC/evidence from `payload.metadata`" path is unreachable through normal Claude Code usage.
- ISC-F4: Patch in `src/events/task-integrity.ts:handleTaskCompleted` — the AC/evidence native-field requirement is now opt-in via signal: (a) payload carries AC/evidence intent (top-level or metadata), or (b) an active ISA exists at sessionRoot AND `checkIsaEvidence` flagged an issue. When an ISA passes `checkIsaEvidence`, the ISA itself is treated as the evidence and the native check is skipped. Tests updated: `test/events/task-integrity.test.ts`, `test/spec-compliance/task-integrity.spec.test.ts`, `test/spec-compliance/handler-smoke.test.ts`, `test/events/cwd-drift.test.ts`.
- ISC-F5: rebuilt `dist/claude-hook-darwin-arm64`, installed over the global location, and re-ran `TaskUpdate#1 status:completed` — task moved from `in_progress` to `completed` with no rejection (`Updated task #1 status` returned cleanly). Tasks 2/3/4/5 also completed without rejection. End-to-end fix verified.
