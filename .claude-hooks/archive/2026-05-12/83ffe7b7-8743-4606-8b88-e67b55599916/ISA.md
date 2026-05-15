---
effort: advanced
phase: complete
tier: E3
---

# ISA — Smart Auto-Verification Gate (`verify-map.yaml`)

## Problem

The Stop hook already blocks completion when files changed without
verification, but it only emits a *reminder*. Claude must then choose and run
the right command — the canonical agent failure mode (wrong test, forgotten
test, over-broad test). The runtime knows files changed; it should run the
mapped check itself.

## Vision

A declarative `verify-map.yaml` (glob → command → timeout) loaded at Stop.
When files changed and verification hasn't passed, Stop selects matching
commands, runs them with bounded timeouts, marks `verification_status`, and:

- on **pass** → allow Stop
- on **fail/timeout** → block Stop with `command + stderr tail`
- on **no rule match** → fall through to today's reminder block

This converts the Stop gate from "please verify" to "verified or blocked."

## Out of Scope

- LLM-driven test selection
- Repo profiling / heuristic command discovery
- Dashboards / telemetry UI
- Evidence-packet schema changes
- Cross-repo orchestration
- Ledger / probe / ISA criteria coupling

## Constraints

- Pure deterministic glob → command resolution; no inference at hook time.
- Per-command `timeoutMs` honored; verifier total must fit under Stop handler
  budget; installer's external hook timeout (30s) is the outer envelope.
- Must NOT re-run when `verification_status === "passed"` (cache hit from
  either heuristic detection in `batch-context-governor` or a prior Stop
  verifier run this session).
- Verify-map failures must NOT set `stop_blocked_once` — verification failure
  is the gate, not a one-shot reminder; otherwise the next Stop is forced
  through and the flagship promise breaks.
- Must degrade silently when `verify-map.yaml` is absent or malformed; today's
  reminder behavior preserved.
- Honor cwd-reset lifecycle: when `cwd-changed` clears `files_changed`, stale
  verification state must not trigger a spurious run.
- Must not require schema changes to `SessionState` (use existing
  `verification_status`, `files_changed`, `commands_run`, `tests_run`,
  `commands_failed`).

## Goal

Ship the smallest correct version that:

1. Parses `.claude-hooks/verify-map.yaml`.
2. Selects matching commands with deterministic ordering (priority then
   specificity) and dedupes identical commands.
3. Runs them with bounded timeouts inside the Stop handler.
4. Updates `verification_status` and ledger lists.
5. Allows or blocks Stop based on outcome; preserves reminder fallback.
6. Adds `doctor` checks for parse health and (best-effort) match coverage.

## Criteria

- **ISC-1** YAML loader accepts both string and `[cmd, ...args]` commands,
  optional `timeoutMs` and `priority`; malformed input emits a stderr warning
  and yields zero rules (no throw).
- **ISC-2** `selectVerifyCommands(changedFiles, rules)` orders by `priority`
  ascending then by `specificity` descending; identical commands (string
  trim or array JSON identity) deduped.
- **ISC-3** Stop runs the verifier ONLY when `files_changed.length > 0` AND
  `verification_status !== "passed"` AND verify-map has matches.
- **ISC-4** Each command runs under its `timeoutMs` (default 20_000 ms, hard
  cap 25_000 ms); exit code + tail of stderr/stdout captured.
- **ISC-5** On all-pass: `verification_status = "passed"`, `tests_run`
  appended, Stop falls through (`SAFE_DEFAULT`).
- **ISC-6** On any fail/timeout: `verification_status = "failed"`,
  `commands_failed` appended, Stop returns `{decision:"block", reason:<cmd
  + tail>}`, and `stop_blocked_once` is NOT set.
- **ISC-7** When verify-map has zero matches, today's `BLOCK_REASON` reminder
  fires unchanged.
- **ISC-8** Dispatcher per-handler timeout for `Stop` is raised to fit the
  verifier budget; existing `UserPromptSubmit` raise pattern reused.
- **ISC-9** `claude-hooks-doctor` reports `verify-map.yaml` parse status; when
  session state shows changed files with zero matching rules, emits a WARN.
- **ISC-10** When `verify-map.yaml` is absent, behavior is byte-identical to
  pre-feature for the Stop path (regression-locked by a test).

## Features

- `src/policies/verify-map.ts` — YAML schema, loader, matcher, selector
  (priority/specificity ordering, dedupe).
- Stop-handler branch inserted before existing reminder block in
  `src/events/stop-definition-of-done.ts`.
- Dispatcher Stop timeout entry in `src/dispatcher.ts`.
- `scripts/doctor.ts` — parse-health + coverage warning checks.
- Tests under `test/policies/verify-map.test.ts`,
  `test/events/stop-auto-verify.test.ts`,
  `test/scripts/doctor-verify-map.test.ts`.

## Test Strategy

Unit:
- Parse string command, array command, with/without `timeoutMs`/`priority`.
- Missing file → empty rules.
- Malformed YAML → empty rules + stderr warning.
- Selector: single match, multi-match priority order, specificity tiebreak,
  duplicate command dedupe (string and array forms).

Integration (Stop hook):
- Changed files + matching rule + command passes → status=passed, Stop
  allowed.
- Changed files + matching rule + command fails → status=failed, Stop blocks
  with reason containing command and stderr tail; `stop_blocked_once`
  remains false.
- Changed files + matching rule + command times out → status=failed, Stop
  blocks with timeout-flavored reason.
- Changed files + zero matching rules → today's reminder reason fires.
- Pre-existing `verification_status=passed` (heuristic from
  batch-context-governor) → verifier skipped.
- Cwd switch resets `files_changed` → verifier does not run on next Stop.

Regression:
- No `verify-map.yaml` → existing behavior bit-identical.
- Dispatcher Stop timeout: handler returning at ~23s does not trip cap.

## Decisions

- Reuse `regenerate.ts` parser shape (one parser for both YAMLs is a later
  cleanup; out of scope for MVP).
- Specificity = `source.replace(/\*/g, "").length`; good enough for MVP.
- Do not introduce `last_verify_block_fingerprint`; instead, refuse to set
  `stop_blocked_once` on verify-map failure. Simpler, fewer schema changes.
- No `source`/`files` alias — pick `source` only; matches `regenerate.yaml`.
- **One verifier command per Stop** (highest-priority match wins). Users
  compose multi-checks into one wrapper script. Avoids total-budget
  scheduling and keeps the envelope honest.
- **Timeout envelope:** external 30_000, Stop handler 28_000, verifier
  command default 15_000, hard cap 22_000. Leaves ~6s overhead for state
  writes, regen, and output capture.
- **Raise `Stop` dispatcher cap to 28_000.** Fixes the pre-existing latent
  bug where today's regen branch (10s execFile) silently races the 4s
  default cap → SAFE_DEFAULT.
- **Regen runs only inside remaining Stop budget** post-verifier. Skip with
  stderr log if budget insufficient; never block.

## Verification

- **ISC-1** — `parseVerifyMapYaml` handles string/array commands, optional
  `timeoutMs`/`priority`, missing required fields, multiple rules. Loader
  returns `[]` on absent file. Evidence: `test/policies/verify-map.test.ts`
  ("parses single rule…", "parses array-form command…", "rejects rule
  missing required source or command", "parses multiple rules", "returns
  [] when verify-map.yaml absent").
- **ISC-2** — `selectVerifyCommand` orders by priority asc, specificity
  desc, stable index tiebreak. Evidence: `test/policies/verify-map.test.ts`
  ("picks lowest priority first", "ties broken by source specificity",
  "ties broken by stable original order").
- **ISC-3** — Stop verifier runs only when `files_changed > 0 AND
  verification_status !== "passed" AND rule matches`. Evidence:
  `test/events/stop-auto-verify.test.ts` ("verification_status already
  passed → verifier skipped", "no verify-map rule matches → existing
  reminder block").
- **ISC-4** — `runVerifyCommand` honors `timeoutMs`; default 15_000 / max
  22_000 enforced in parser. Evidence: `test/policies/verify-map.test.ts`
  ("times out a long-running command", "clamps oversize timeoutMs"),
  `test/events/stop-auto-verify.test.ts` ("auto-verify timeout → Stop
  blocks").
- **ISC-5** — Pass path: `verification_status=passed`, `tests_run`
  appended, Stop returns `{}`. Evidence: `test/events/stop-auto-verify
  .test.ts` ("auto-verify passes → Stop allowed").
- **ISC-6** — Fail path: `verification_status=failed`, `commands_failed`
  appended, Stop returns `block` with command + tail; `stop_blocked_once`
  remains `false`. Evidence: `test/events/stop-auto-verify.test.ts`
  ("auto-verify fails → Stop blocks…; stop_blocked_once stays false").
- **ISC-7** — No matching rule → existing `BLOCK_REASON` reminder fires.
  Evidence: `test/events/stop-auto-verify.test.ts` ("no verify-map rule
  matches → existing reminder block still fires").
- **ISC-8** — Dispatcher `Stop` cap raised to 28_000. Evidence:
  `src/dispatcher.ts:256-264` (HANDLER_TIMEOUT_MS entry); existing
  `test/dispatcher-timeout.test.ts` continues to pass (full suite 1171/0).
- **ISC-9** — `claude-hooks-doctor` reports verify-map parse health.
  Evidence: `scripts/doctor.ts` `checkVerifyMap` function +
  `runDoctor` integration.
- **ISC-10** — Absent `verify-map.yaml` preserves bit-identical
  pre-feature behavior for Stop. Evidence:
  `test/events/stop-auto-verify.test.ts` ("verify-map.yaml absent →
  behavior identical to pre-feature") plus the existing
  `test/events/stop-definition-of-done.test.ts` suite all green.

Full-suite proof: `bun test` → 1171 pass / 0 fail / 3372 expect calls.
`bun run typecheck` → exit 0.

## Changelog

- 2026-05-11 observe: ISA created from initial proposal.
- 2026-05-11 plan: refined after reading dispatcher, Stop handler,
  PostToolBatch, regenerate policy, SessionState. Confirmed most scaffolding
  exists; identified narrow MVP delta.
- 2026-05-11 plan: timeout decisions locked (one-command MVP, Stop cap
  28_000, command default 15_000 / max 22_000, regen budget-gated).
  Implementation greenlit.
- 2026-05-11 implement: shipped `src/policies/verify-map.ts`,
  `src/dispatcher.ts` Stop cap bump, Stop-handler auto-verify branch +
  budget-gated regen, `scripts/doctor.ts` health check, and tests
  (`test/policies/verify-map.test.ts`, `test/events/stop-auto-verify
  .test.ts`). Full suite 1171/0, typecheck clean.
- 2026-05-11 complete: all 10 ISCs have matching Verification entries.
- 2026-05-11 audit (observe→complete): fresh-eyes critical pass.
  Self-fixed: (a) silent verifier-runner crash now logs to stderr via
  `Effect.tapError` before falling through; (b) regen budget gate now
  requires `REGEN_TIMEOUT_MS + 1s` margin so state I/O doesn't bleed past
  the dispatcher cap; (c) `runVerifyCommand` timeout detection
  simplified to `e.killed === true` (signal-name independent); (d)
  `String()` defensive coerce for success-path stdout/stderr;
  (e) `maxBuffer` bumped from 1 MB → 10 MB so verbose test failures
  don't error out as ENOBUFS; (f) explicit trust-boundary doc-comment.
  External automation also fixed two real bugs I missed during my
  audit: (1) `files_changed` paths are typically absolute but verify-map
  source globs are repo-relative — wired
  `expandPathMatchCandidates(currentCwd, files_changed)` so either
  form matches (regression test "absolute files_changed paths…"); (2)
  `./src/*.ts`-style patterns now run through `normalizePathPattern`
  in both `matchVerifyRules` and `specificityOf` (regression test
  "./-prefixed source patterns match normalized…"). Full suite 1175/0,
  typecheck clean.

---

# Audit pass — PR #44 (priming-vs-gating split)

```
effort: deep
phase: complete
tier: E4
```

## Problem
PR #44 introduces a new persisted boolean (`requires_web_sources`), a strict
predicate (`requiresWebSources`), a priming-regex tighten, and a Stop-gate
keying change. Fresh-eyes audit for bugs / types / security / reliability /
architecture before merge.

## Vision
Catch defects in the diff that the implementation pass missed; fix narrowly.

## Out of Scope
- Wholesale tightening of other loose priming alts (`secret`, `slow`, etc.)
- Long-term Sonnet-emits-workflow refactor
- Migration tooling for on-disk session-state files

## Principles
- Threat-model first; all user-prompt input is hostile.
- Deny-by-default for the gate; false positives are user-hostile, false
  negatives are silent quality regressions.
- Preserve existing call-site contracts unless they're load-bearing-wrong.

## Constraints
- Cannot break the 1217 existing tests.
- Cannot change the on-disk schema in a way that strands existing session
  state JSON files (forward-compat default merge must handle the new field).
- New regex must not introduce ReDoS-class backtracking.

## Goal
Identify and fix correctness/safety defects in the PR diff. Re-run typecheck
+ full suite + targeted gate tests.

## Criteria
- **AUD-1** Regex audit: no ReDoS, no overly-permissive alternatives.
- **AUD-2** Forward-compat decode: legacy state JSON without the new field
  produces `requires_web_sources: false` (deny-by-default).
- **AUD-3** Strict-mode schema decoder accepts records missing the field
  (via the default merge at parseRecordStrict).
- **AUD-4** No silent error swallow on the new persistence path.
- **AUD-5** Predicate behavior is total: never throws on any string input,
  including very long / Unicode / control-char strings.
- **AUD-6** Gate semantic check: every persistence write of
  `requires_web_sources` is paired with a `last_workflow` write OR a clear
  reset path, so the two never drift inconsistently.
- **AUD-7** Tests cover the deny-by-default property and the strict-mode
  decoder path.

## Test Strategy
- Static read of the diff hunk by hunk.
- Run targeted tests for each fix.
- Final `bun test` + `bun run typecheck`.

## Features
- Diff walkthrough notes
- Fixes (1 per finding)
- Regression tests for fixes worth pinning

## Decisions
_(to be populated as findings land)_

## Changelog
- 2026-05-12 audit start.

## Verification
_(populated per ISC after fixes land)_

## Verification (audit pass)

- **AUD-1** — Regex audit completed; one finding fixed
  (`\bcurrent best practice/i` had no closing boundary → tightened to
  `\bcurrent best practices?\b`). No ReDoS; all `WEB_SOURCES_REQUIRED`
  regexes are linear, no nested quantifiers. Evidence: commit `63e13f4`,
  `src/policies/workflow-classifier.ts` line for `WEB_SOURCES_REQUIRED`.
- **AUD-2** — Lenient decoder deny-by-default pinned by new test in
  `test/services/session-state-schema.test.ts` ("legacy JSON missing
  `requires_web_sources` → field defaults to false").
- **AUD-3** — Strict-mode decoder forward-compat verified by the same
  test (no corrupt-backup sibling created; the default merge fills the
  missing field before schema decode).
- **AUD-4** — Persistence write path traced: `state.update(sessionId,
  { last_workflow, requires_web_sources })` is wrapped by
  `Effect.catchAll` that writes to stderr with the cause. Not silent.
- **AUD-5** — Predicate totality: `(rawPrompt ?? "").trim()` then early
  return on empty handles `null`/`undefined`/empty inputs. No length
  cap, consistent with the existing `classifyPrompt` behavior in the
  same file.
- **AUD-6** — `last_workflow` and `requires_web_sources` are written in
  a single `state.update` call (`prompt-router.ts`). They cannot drift
  inconsistently.
- **AUD-7** — Property test (workflow-classifier.test.ts) covers
  deny-by-default for common-English short prompts. Legacy-decoder
  test (session-state-schema.test.ts) covers the migration path. The
  fixup commit also rewrote the misleading prompt-router persistence
  test to actually pin the decoupling contract (loose priming +
  strict-false case).

Full suite: 1218 pass / 0 fail / 3435 expect calls. Typecheck: exit 0.

## Changelog (audit pass)

- 2026-05-12 audit start (E4, fresh eyes on the PR #44 diff).
- 2026-05-12 audit fixup commit `63e13f4`: three findings fixed (regex
  boundary, misleading test prompt, missing migration test). Audit
  complete; phase: complete.
