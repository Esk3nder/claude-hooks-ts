---
effort: deep
phase: observe
---

## Phase 3 — Fresh-eyes audit of merged PR #38

### Audit Problem

PR #38 just merged a multi-commit ISA cwd-drift fix plus several
autonomous refactors (engagement-gate deepening, session-state slice
split, lifecycle façade). The user asked for a critical fresh-eyes pass
across the merged surface area looking for bugs, edge cases, type/error
gaps, silent failures, perf, security, reliability, and architecture
issues. Threat-model lens (coding.security workflow): all inputs hostile,
no secrets in logs, deny-by-default tests.

### Audit Vision

A merged-but-correct codebase with all surfaced issues either fixed or
explicitly triaged. The engagement gate is a security boundary; nothing
in the cwd-drift fix should weaken its deny-by-default posture.

### Audit Out of Scope

- Pre-existing code outside the PR #38 surface area unless it's a direct
  vulnerability discovered en route.
- Style nits, comment polish, dead-code removal not security-relevant.
- Architectural overhauls beyond what each finding requires.
- Re-opening already-tracked follow-ups (LEGACY_WORK_SUBPATH retirement,
  cwd-drift telemetry).

### Principles

- Deny-by-default for any ISA-identity logic. When in doubt, the gate
  denies; the model's escape hatch is `CLAUDE_HOOKS_DISABLE_ISA_PRETOOL_GATE`.
- All filesystem paths in the gate are realpath-normalized before
  string comparison.
- All external inputs (payloads, on-disk JSON, env vars) are decoded
  before use; corrupt state goes to a `.corrupt-*.bak` and resets, never
  silently fills defaults from garbage.
- Hooks must never block on long IO; sync helpers have hard timeouts.
- No secrets in logs. Hook stderr lines are user-visible.

### Constraints

- Hook latency budget: handlers should stay <100ms when not
  classifier-bound; project-root detection caps at 500ms.
- Must remain backward-compatible with old session-state JSON.
- Must remain mergeable: no breaking signature changes on exported
  APIs unless every caller is updated in the same commit.

### Goal

Identify and fix any real defect in the merged cwd-drift / engagement
work; document deliberate trade-offs and produce tests that pin the new
behaviour.

### Criteria

- [ ] AUD-1 — Read each merged source file with the audit lens and
  produce a written findings list with severity (P1/P2/P3) and location
  (file:line).
- [ ] AUD-2 — Patch every P1 finding (correctness/security blocker).
- [ ] AUD-3 — Patch every P2 finding (silent-failure / robustness)
  unless explicitly deferred with rationale.
- [ ] AUD-4 — Add regression tests for any P1 fix.
- [ ] AUD-5 — `bun test`, `bun run typecheck`, `bun run lint:claude-spawn`
  all pass with no new failures.

### Test Strategy

- Targeted unit tests for any new branch added by a fix.
- Existing 1126-test full suite must remain green.
- Where the fix is purely defensive (e.g., timeout on a spawnSync), a
  regression test asserting the timeout path is sufficient.

### Features

(Populated as fixes land.)

### Decisions

(Populated as fixes land.)

### Changelog

- 2026-05-11 — Phase 3 audit started against the merged PR #38 surface.

### Verification

Findings produced; patches deferred per user interrupt (then resumed
below as Phase 4).

---

## Phase 4 — Log SessionState fail-open paths in engagement/ISA gates

### Phase 4 Problem

PR #38 correctly freezes ISA identity with `session_root` and
`expected_isa_path_absolute`, but several handlers still catch
SessionState read/write errors silently. On rare state failures, gates
fail open or fall back to current cwd without any diagnostics — the
exact silent-regression mode that masked the original cwd-drift bug
for a full session before it surfaced.

### Phase 4 Vision

Every place a SessionState I/O error is intentionally swallowed emits
one concise stderr line so operators can correlate gate-noop behavior
with on-disk state failures. Fail-open is preserved; observability is
added.

### Phase 4 Out of Scope

- Turning fail-open into fail-closed.
- Centralising state I/O behind a new abstraction.
- Logging routine state reads / writes that did not fail.
- Reworking the `Effect.catchAll` plumbing pattern (the new helper, if
  any, must be a thin one-liner).

### Phase 4 Constraints

- Log line format: `[<event>] session-state <op> failed: sid=<sid>
  cause=<truncated>`. Cause truncated at 160 chars so a stack-trace
  doesn't flood the user-visible stderr stream.
- Must not leak secrets. `FsError.message` is bounded by SessionState's
  own constructor (project-local paths only).
- Must not change the public Effect signature of any handler.
- Test isolation: any new test must use a SessionStateTest with a
  custom failing layer rather than mocking process.stderr globally —
  several existing tests already capture stderr that way.

### Phase 4 Goal

Replace the 10 silent `catchAll` swallows in the engagement choreography
with logged versions; pin the contract with one regression test.

### Phase 4 Criteria

- [x] ISC-4.1 — `prompt-router.ts` logs workflow-update,
  existing-state-read, and engagement-bookkeeping-update failures.
- [x] ISC-4.2 — `pretool-policy.ts` logs state-read failure before the
  engagement gate.
- [x] ISC-4.3 — `stop-definition-of-done.ts` logs state-read and each
  `stop_blocked_once` write failure (all three call sites covered by
  one `replace_all` edit that picked up every `stop_blocked_once`
  write).
- [x] ISC-4.4 — `task-integrity.ts` logs state-read failure before ISA
  evidence lookup.
- [x] ISC-4.5 — `post-edit-quality.ts` logs state-read and
  `isa_engaged_at` write failure.
- [x] ISC-4.6 — Behaviour preserved: each `catchAll` still returns the
  same fallback (`null` for reads, `undefined` for writes) as before.
- [x] ISC-4.7 — `test/events/session-state-fail-logging.test.ts`
  defines a `FailingSessionState` layer whose every API method fails
  with FsError, drives `handlePreToolUse` against it, and asserts the
  expected log line tokens. A second test pins the 160-char cause
  truncation contract.
- [x] ISC-4.8 — Full suite `bun test`: 1133 pass / 0 fail across 114
  files. `bun run typecheck`: clean. `bun run lint:claude-spawn`: clean.

### Phase 4 Features

- F-4.1 — Small inline pattern at each catch site:

      .pipe(Effect.catchAll((cause) => {
        process.stderr.write(
          `[<event>] session-state <op> failed: sid=${sid} cause=${String(cause).slice(0, 160)}\n`,
        )
        return Effect.succeed(<fallback>)
      }))

  No new module — the user's new doctrine ("Make the smallest correct
  change") rules out introducing a helper for a 10-site change of
  1-line logic.

- F-4.2 — One regression test in
  `test/events/prompt-router.test.ts` (or a small new file): provide a
  SessionStateTest whose `get` and `update` reject, capture
  process.stderr, run a prompt, assert each expected log line appears.

### Phase 4 Test Strategy

- Capture process.stderr via a swap-and-restore wrapper (same pattern
  used by `test/services/session-state-schema.test.ts`).
- Use an `InferenceTest(FAIL_SAFE)` so the engagement-bookkeeping
  write path is exercised.
- Provide a custom SessionState layer whose API methods return
  `Effect.fail(new FsError(...))` so every catchAll fires.
- Assert each tag appears at least once: `[UserPromptSubmit]`,
  `op=workflow-update`, `op=engagement-update`, `op=get`.

## Phase 2 — P2 follow-ups from PR #38 review

### P2 Problem

Three follow-ups the reviewer flagged on PR #38 as non-blockers but
worth addressing:

- **P2a (deny messages)**: PreToolUse deny reason names only the relative
  ISA path (`.claude-hooks/work/<sid>/ISA.md`). After a Bash cd into a
  drifted directory, the model has no way to know the absolute target
  it's allowed to write. The mkdir hint already shows the absolute dir,
  but the write/edit guidance does not. Same gap in Stop's
  engagement-absence block reason.
- **P2b (lifecycle.ts comment drift)**: A comment still references the
  legacy `state/work/<slug>/ISA.md` layout, but canonical task ISAs now
  live under `.claude-hooks/work/<slug>/`. Cosmetic, but reinforces the
  wrong mental model.
- **P2c (probe runner cwd)**: `handlePostToolUseIsaEffects()` calls
  `findLatestISA()` / `findProjectIsa()` with no root argument, defaulting
  to `process.cwd()`. After Bash cd drift, the post-edit probe runner
  edits / commits the wrong ISA (or none at all). Symmetric to the gate
  fix.

### P2 Vision

The model always sees the unambiguous absolute path it's allowed to
write. Comments accurately reflect the canonical filesystem layout.
PostToolUse probe runner uses the same frozen `session_root` as
PreToolUse / Stop / TaskCompleted.

### P2 Out of Scope

- Reformatting the deny message body beyond inserting the absolute path.
- Wider refactor of `engagement-gate.ts` (the deepened module shape from
  the autonomous refactor stays as-is).
- Cwd-drift handling for non-ISA PostToolUse policies (regenerate.yaml
  etc.) — those are intentionally cwd-scoped.

### P2 Constraints

- `denyReason` is purely string-building; can take an extra optional
  parameter for the absolute path without breaking the public signature.
- `handlePostToolUseIsaEffects` is called from the dispatcher; signature
  change must keep callers passing the right root or use a default of
  `process.cwd()` so non-engagement sessions are unchanged.
- The probe runner edits the ISA on disk and runs checkpoint — both
  must be aimed at the same ISA. Use one consistent root through both
  branches.

### P2 Criteria

- [x] ISC-P2a — `engagement-gate.ts` deny message names the absolute
  ISA path when known.
- [x] ISC-P2b — `stop-definition-of-done.ts` absence reason names the
  absolute ISA path when state has one.
- [x] ISC-P2c — `lifecycle.ts` comment about ISA discovery uses the
  canonical `.claude-hooks/work/<slug>/` path (no stale
  `state/work/<slug>/` wording).
- [x] ISC-P2d — `handlePostToolUseIsaEffects(root)` accepts a root;
  PostToolUse caller threads `record.session_root` (or current cwd
  fallback) through it.
- [x] ISC-P2e — Tests pin: deny reason contains the absolute path,
  Stop absence reason contains the absolute path, probe runner uses
  the passed root for ISA lookup.
- [x] ISC-P2f — `bun test` full suite, typecheck, lint all clean.

### P2 Features

- F-P2a — Extend `denyReason` to accept and surface
  `displayIsaAbsolutePath`; wire through from `evaluateEngagementGate`
  using the existing absolute path the gate already computes.
- F-P2b — Update the Stop absence block reason to include the
  absolute path when `record.expected_isa_path_absolute` is set.
- F-P2c — Single-line comment edit in `lifecycle.ts`.
- F-P2d — Extend `handlePostToolUseIsaEffects` signature to take an
  optional `cwd`, then update the PostToolUse handler to pass
  `record.session_root ?? cwd`.
- F-P2e — Add tests for the new absolute-path surfaces and probe-runner
  root.

### P2 Test Strategy

- Extend `test/policies/engagement-gate-paths.test.ts` with one
  assertion that the deny reason contains the absolute path.
- Extend `test/events/stop-isa-gate.test.ts` with an assertion the
  absence reason contains the absolute path.
- Add a probe-runner test that proves it follows the passed root
  rather than `process.cwd()` (or extend an existing probe test).

### P2 Verification

- ISC-P2a ✅ — `denyReason` now accepts and surfaces a fourth
  `displayIsaAbsolutePath` arg. `EngagementContext.displayIsaAbsolutePath`
  added (optional for back-compat with the shallow-form test suite); the
  deep entry point populates it from `expectedAbsolute`. Test
  `deny reason includes the absolute expected-ISA path` in
  `test/policies/engagement-gate-paths.test.ts` pins the surface.
- ISC-P2b ✅ — `stop-definition-of-done.ts` absence reason now embeds
  both the relative path and `record.expected_isa_path_absolute` when
  set. Test `absence reason includes the absolute expected-ISA path
  when state has one` in `test/events/stop-isa-gate.test.ts` pins it.
- ISC-P2c ✅ — Comment in `lifecycle.ts` updated to reference the
  canonical `.claude-hooks/work/<slug>/ISA.md` layout instead of the
  legacy `state/work/<slug>/ISA.md`. Same comment block now also
  explains that the runner is rooted at the frozen `session_root`.
- ISC-P2d ✅ — `handlePostToolUseIsaEffects` now takes `cwd: string =
  process.cwd()` and threads it through `probesPathFor`, `findLatestISA`,
  `findProjectIsa`, `loadProbes`, and `runCheckpoint`. The PostToolUse
  handler in `post-edit-quality.ts` reads `record.session_root` once
  (hoisted out of the engaged-marker branch so we don't read state
  twice) and passes it to both `runCheckpoint` (branch a) and
  `handlePostToolUseIsaEffects` (branch c).
- ISC-P2e ✅ — Three pinning tests added:
  - `deny reason includes the absolute expected-ISA path`
    (engagement-gate-paths)
  - `absence reason includes the absolute expected-ISA path when state
    has one` (stop-isa-gate)
  - `probe runner uses session_root, not process.cwd()` (integration)
- ISC-P2f ✅ — `bun test`: 1126 pass / 0 fail across 111 files. `bun
  run typecheck`: clean. `bun run lint:claude-spawn`: clean.

---

## Problem

PR #38 review surfaced a P1 blocker the original implementation missed:
`prompt-router.ts` runs `detectSessionRoot` on every ALGORITHM E3+
`UserPromptSubmit` and writes the result into `SessionState`, unconditionally
overwriting any previously-frozen `session_root` and `expected_isa_path_absolute`.

Failure path: a session starts in the repo, freezes `session_root = /repo`,
then drifts via Bash `cd ~/.claude/skills/...`. The user sends a second
ALGORITHM E3+ prompt. The router refreezes the root against the drifted cwd,
and the gate begins denying the original frozen ISA again. Verified
empirically this run: the previous prompt's frozen root (`/Users/eskender_archetype`)
was overwritten the moment a new ALGORITHM E3+ prompt arrived from inside the
repo, invalidating the ISA at the previously-frozen path.

The PR closed the within-prompt drift but reopened the across-prompt drift.

## Vision

`session_root` and `expected_isa_path_absolute` are write-once for the
lifetime of a session. Once an ALGORITHM engagement freezes the root, every
subsequent prompt — regardless of `payload.cwd` at the time — reads back the
same values.

## Out of Scope

- Cross-session migration (a new session_id legitimately freezes a new root).
- PostToolUse probe runner cwd handling (separate P2 follow-up).
- Display-string improvements that surface absolute paths in deny/Stop
  messages (separate P2 follow-up; tracked but not in this PR).
- Lifecycle.ts comment drift about `state/work` paths (separate P2).

## Constraints

- Must not introduce a `SessionState.read` before the existing
  `state.update` in `prompt-router`; the gen function already loads
  state via `yield* state` at the workflow step. Keep it cheap.
- The read must tolerate `null` (a fresh session whose record is missing).
- `Effect.catchAll` keeps the read non-fatal — engagement bookkeeping is
  best-effort and must not block prompt dispatch on FS error.
- Test must drive the *real* `prompt-router` against a seeded
  `SessionStateTest` so the assertion is over the live update logic, not a
  spec mock.

## Goal

Patch `prompt-router` so an existing `session_root` /
`expected_isa_path_absolute` is preserved across subsequent ALGORITHM E3+
prompts. Add a regression test that pins this. Push to PR #38.

## Criteria

- [x] ISC-1 — `prompt-router.ts` reads existing record once, preserves
  `session_root` if already non-null on engagement.
- [x] ISC-2 — Same for `expected_isa_path_absolute`.
- [x] ISC-3 — Behavior unchanged when no prior record exists (fresh
  freeze on first ALGORITHM E3+ prompt).
- [x] ISC-4 — Regression tests in `test/events/cwd-drift.test.ts` drive
  the real `handleUserPromptSubmit` with drifted cwd and assert the
  stored fields do not move.
- [x] ISC-5 — `bun test` full suite passes; typecheck and lint clean.
- [ ] ISC-6 — Commit pushed to `refactor/isa-tier-policy`, PR #38 picks
  up the fix automatically.

## Features

- F1 — Read existing SessionState record in `prompt-router` before
  computing engagement fields; reuse its `session_root` and
  `expected_isa_path_absolute` when present.
- F2 — Add `repeated ALGORITHM prompt under drifted cwd does not move
  frozen root` to the cwd-drift regression suite. The router needs the
  full UserPromptSubmit dependency set (`Inference`, `ClaudeSubprocess`,
  `ClassifierTelemetry`); test exercises the SessionState patch path
  by post-condition assertion instead of dispatching through the full
  classifier — assert via direct state read after a single
  `state.update` simulation of what the router would write. (If a
  classifier-driving test is simpler with existing test fixtures, prefer
  that — but the post-condition shape is the contract.)

## Test Strategy

- Targeted: extend `test/events/cwd-drift.test.ts` with a SessionStateTest
  preseeded with a frozen root; invoke a helper that mirrors the
  prompt-router's "compute engagement fields" branch using the same logic,
  and assert no overwrite. Equivalent fidelity to the real handler with no
  classifier subprocess cost.
- Existing: full `bun test` suite must remain at 1100+ pass / 0 fail.

## Verification

- ISC-1 ✅ — `prompt-router.ts` now calls `state.get(sessionId)` before
  computing engagement fields and uses
  `existing?.session_root ?? detectSessionRoot(initialCwd)`.
- ISC-2 ✅ — Same fallback chain for
  `existing?.expected_isa_path_absolute ?? safeResolvePath(...)`.
- ISC-3 ✅ — `first ALGORITHM prompt with no existing record still
  freezes a root` test passes; an empty SessionStateTest (EMPTY record
  with both fields null) falls through to detectSessionRoot.
- ISC-4 ✅ — `test/events/cwd-drift.test.ts` adds:
  - `repeated ALGORITHM prompt under drifted cwd preserves frozen root`
  - `first ALGORITHM prompt with no existing record still freezes a root`
  Both drive the real `handleUserPromptSubmit` under shared
  `SessionStateTest` + `InferenceTest(FAIL_SAFE)` and assert the
  post-update state.
- ISC-5 ✅ — `bun test`: 1113 pass / 0 fail across 110 files.
  `bun run typecheck`: clean. `bun run lint:claude-spawn`: clean.
- ISC-6 — Pending push (next action).

## Collateral

- `test/events/task-integrity.test.ts` wrapper now selects between an
  isolated `session_root` tmpdir (when payload lacks `cwd`) and an empty
  SessionState (when payload pins `cwd`). This made AC/evidence-focused
  tests hermetic against a real-world ISA living under
  `.claude-hooks/work/<session-id>/ISA.md` in the dev's working tree
  (exposed when this run's engagement gate created one in-tree).
