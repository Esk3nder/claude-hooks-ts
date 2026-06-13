# claude-hooks-ts Streamline & Transplant — Migration Plan

**Version:** 0.2 (revised in joint review — the Algorithm is retained, invocation-based)
**Date:** 2026-06-12
**Baseline:** commit `36db2cc` (2026-05-24), `src/` = 24,972 lines, full repo incl. tests ≈ 66.5k lines.
**Inputs:** the first-principles audit (2026-06-11, incl. mode-classifier telemetry: p50 5.5s/prompt, 39% E3+ escalation), the claude-workers v1.0 spec + live-verified implementation (88 tests; live run: contract blocks → pinned replay match → accepted), the P0 host-conformance probes on Claude Code 2.1.174, and the 2026-06-12 review decision: **the Algorithm stays; the classifier goes.**

## Intent

One repo — this one — streamlined to its defensible core: the worker plane replaced by the live-verified seam mechanisms, the **measured taxes removed without removing the methodology**, and outcome instrumentation added so future changes are judged by ledger data. The Algorithm (ISA decomposition, probe-verified criteria, completion discipline) is retained as a first-class **user-invoked mode** and becomes the planning layer that feeds worker briefs. Target end state: `src/` ≈ 12–15k lines (from 25k), zero LLM calls in any hook path, prompt-path latency 0ms.

**Non-goals:** changing the Effect architecture; touching installer/doctor UX conventions; verify-map semantics changes beyond M1's advisory-path fix; weakening the Algorithm *within* sessions that invoked it.

---

## The core review decision (2026-06-12)

> The Algorithm is great for hard problems and pairs naturally with worker handoff. Don't cut it — cut what forces it.

Operationalized as three rules:

1. **Invocation replaces classification.** The Algorithm engages when the user invokes it (skill/command, e.g. `/algorithm [tier]`) or accepts a cheap, regex-only nudge ("this looks E3-shaped — want the Algorithm?"). No LLM call ever decides ceremony. The per-prompt Sonnet classifier, inflation/deflation guards, and fail-safe-to-E3 are deleted.
2. **Opt-in gates are legitimate gates.** Within an invoked Algorithm session, the engagement gate (ISA before implementation tools) and the Stop completeness gate (ISCs verified before done) remain **blocking** — a chosen seatbelt, not an imposed one. Outside invoked sessions, none of that machinery runs at all.
3. **World-facts over structure.** ISC checkboxes flip only via probes or worker replay verdicts (see ISA↔seam wiring below). Structure checks (section counts, exact headings) demote to advisory warnings; they never block.

---

## The keep / cut / port map (file level)

### KEEP — unchanged (safety + context plane)

| Area | Files |
| --- | --- |
| Safety policies | `policies/destructive-commands.ts`, `secret-paths.ts`, `protected-paths.ts`, `settings-self-protection.ts`, `generated-files.ts`, `lockfile-paths.ts`, `permission-patterns.ts`, `path-utils.ts`, `hook-owned-path.ts`, `inspection-whitelist.ts`, `content-scan.ts` (report-only) |
| Stop verification | `policies/regenerate.ts` + verify-map execution (extracted to lean `stop-verify.ts`); **M1 adds the "unmatched changed files are advisory" path** (the docs/MIGRATION-PLAN.md block loop, 4 consecutive turns, is the case study) |
| Context plane | `session-start-brief`, `precompact-snapshot`, `postcompact-ledger` (ISA rehydration stays — it serves the retained Algorithm), `session-ledger`, `stop-failure`, `failure-explainer` (+ `failure-parsers`), `cwd-changed` (frozen engagement fields stay — Algorithm sessions still need them), `config-guard`, `filechanged-env-guard`, `instructions-loaded`, `notification`, `setup`, `elicitation*`, `user-prompt-expansion` |
| Permissions | `permission-autopilot`, `permission-denied` |
| Worktrees | `worktree-remove`; `worktree-create` **after the M1 fix** |
| Services | `shell`, `event-store`, `redact`, `diagnostics`, `command-runner`, `project-root`, `path-resolution`, `session-state` (engagement fields retained, classifier fields removed) |

### KEEP — RESHAPED (the Algorithm, invocation-based)

| Component | Change |
| --- | --- |
| `algorithm/isa/**` (lifecycle, completeness, checkpoint, probes) | kept; completeness structure checks → advisory; probe-driven ISC flips stay blocking-relevant at Stop |
| `policies/engagement-gate.ts` | kept; active **only** when session state shows an explicit invocation (new `engagement_source: "user"` field); no classifier-set engagement exists anymore |
| Stop ISA gate (within `stop-verify.ts`) | kept for invoked sessions: every ISC needs probe/replay/worker evidence; section-count checks advisory |
| `events/task-integrity.ts` | kept, scoped to invoked Algorithm sessions only |
| NEW: invocation entry | small handler + skill: `/algorithm [E3|E4|E5]` sets engagement state, creates the work dir, emits the ISA template as context |
| NEW: regex nudge (optional, default on, <5ms) | suggests invocation on E3-shaped prompts; suggestion only, never engages by itself |

### KEEP — NEW WIRING (ISA ↔ worker seam)

| Mechanism | Behavior |
| --- | --- |
| ISA → briefs | `## Features`/`## Criteria` entries can declare `brief: <label>`; the delegation flow registers the brief with the ISC id in its metadata |
| Replay → ISC | a worker run whose seam outcome is `accepted` (replay match) flips the linked ISC, exactly like a probe pass; `rejected`/`soft_failed` never flips |
| Stop gate | an ISC linked to a brief counts as verified only via the seam outcome — handing labor to workers and verifying their claims becomes one spine |

### CUT (flag-off in M2, delete in M4 — the measured taxes only)

| Area | Files | Basis |
| --- | --- | --- |
| Classifier | `events/prompt-router.ts` (classification path), `algorithm/classifier.ts`, `classifier-contract.ts`, `classifier-inflation-guard.ts`, `transcript-context.ts`, `services/inference.ts`, classifier telemetry | measured 5.5s p50/prompt; 39% escalation; override-resistant; fail-safe = max ceremony |
| Forced engagement | classifier-set engagement paths in `pretool-policy.ts`; `ALGORITHM_ENGAGEMENT_REQUIRED` injection on unrequested turns | ceremony without consent was the Goodhart driver |
| Legacy worker plane | `events/subagent-scope-gate.ts`, `services/worker-supervisor.ts`, `worker-queue.ts`, `worker-runs.ts`, `worker-aggregation.ts`, `worker-context.ts`, `policies/worker-mandatory.ts`, `worker-permissions.ts`, `worker-contract.ts`, `worker-replay-cache.ts`, `worker-verification-replay.ts`, `policies/subagent-roles.ts` | replaced by transplanted seam; supervisor/queue duplicate host lifecycle |
| Mid-session mutation | formatter + checkbox `writeFileSync` machinery in `post-edit-quality.ts` — ISC flips move to the Stop/seam path so files change only at gate evaluation, never mid-edit; `policies/test-output-rewrite.ts`; `events/read-tldr.ts` | hooks must not desync the model's world-state |
| Misc | `policies/context-budget.ts`; `teammate-idle` blocking → advisory; `batch-context-governor.ts` (Q3 stands) | judgment-proxy blocks |

### PORT IN (from claude-workers — unchanged from v0.1)

Brief registration + pre-start trust snapshot; safe replay executor (pinned argv, no shell, minimal env, group-kill — **security-sensitive**); drift + patch-manifest exemption; worker contracts as Effect `Schema`; seam handlers (start/stop pipeline, block budget, verdict files, PostToolUse injection); acceptance ledger + report; host-conformance probes → `claude-hooks-doctor --probe-host`; role definitions + delegation skill (skill gains the ISA→brief convention).

---

## Phases

### M0 — Baseline (½ day) — unchanged
Tag `pre-migration`; suite green on record; settings backup. (Repo has no modified tracked files beyond the verify-map docs rule added 2026-06-12; the untracked `.claude-hooks` state dirs stay untracked.)

### M1 — In-place bug fixes (1–1.5 days) — expanded
1. `worktree-create.ts` fail-open fix (P0 finding) + regression tests; verified by re-running the isolation probe (expect PASS).
2. **Verify-map watermark: unmatched changed files become advisory** (this week's 4-turn block loop is the regression case). The `docs/**/*.md → tsc` appeasement rule added 2026-06-12 is reverted in the same commit.
3. Payload-schema audit against 2.1.174 captures.
**Rollback:** revert commits.

### M2 — Classifier off, invocation in (2 days + observation week)
- Classifier path default-off (`classifierDisabled: true`); prompt-router stops classifying; no engagement is ever set without invocation.
- NEW: `/algorithm` invocation entry + regex nudge land behind a flag, default on.
- Observation: ≥20 real sessions or one week (Q7 resolved). You still get the Algorithm whenever you ask for it; the week measures whether un-asked-for engagement is ever missed.
**Rollback:** flip defaults; classifier code is still present until M4.

### M3 — Seam transplant + ISA wiring (4–6 days)
As v0.1 (characterization-first port of the 88-test intent; atomic cutover commit retiring `subagent-scope-gate`; claude-workers hooks uninstalled), **plus** the ISA↔seam wiring: brief metadata carries ISC ids; seam `accepted` outcomes flip linked ISCs through the same checkpoint path probes use; Stop gate consumes them. Live re-test: the 2026-06-12 worker run repeated through the transplanted seam, expecting the same ledger row shape, plus one invoked-Algorithm session whose ISC is flipped by a worker replay match.
**Rollback:** dispatch flip + hook reinstall.

### M4 — Deletion pass (2 days, gated on M2's clean week + your sign-off)
Delete the CUT list only — classifier/inference/guards, forced-engagement paths, legacy worker plane, mutation machinery. The Algorithm directories stay. Grep audit: no `inference|classifier` references survive; `isa` references survive only behind invocation checks.
**Rollback:** deletion-only commits, clean reverts.

### M5 — Instrumentation, docs, standing eval (1–2 days) — unchanged
Ledger report in `claude-hooks-workers report`; README/ARCHITECTURE rewritten (invocation-based Algorithm doctrine; world-fact gates hard, structure advisory, no LLM in hooks; anti-ratchet rule R8); 4-week eval with kill criteria — now including an Algorithm-specific metric: invoked-session ISC flips by source (probe / worker replay / manual), to see whether manual flips (the theater channel) trend to zero.

---

## Risk register (v0.1 register stands; additions)

| Risk | Mitigation |
| --- | --- |
| Invocation friction: the Algorithm goes unused because invoking it is one step more than the classifier's zero | the nudge exists for exactly this; M5's eval counts invocations/week — if the Algorithm sits idle post-M2, that's data we read together before M4 deletes the classifier |
| ISA↔seam wiring couples the Algorithm and worker planes | the link is one metadata field + one flip adapter; either side functions without the other |
| Manual ISC flips remain possible (model edits the checkbox) | M5 metric makes flip-source visible; demoting manual flips to non-counting is a future decision, not assumed |

## Open questions — updated

- **Q1 (TDD gate):** keep opt-in — *unchanged recommendation*.
- **Q2 (read-tldr):** delete — *unchanged*.
- **Q3 (batch-context-governor):** delete in M4, revive if missed — *unchanged*.
- **Q4 (classifier code):** delete in M4 **after** the M2 week proves invocation covers your hard-problem workflow — now conditional on that evidence.
- **Q5 (teammate-idle):** advisory — *unchanged*.
- **Q6 (claude-workers dir):** archive untouched — *unchanged*.
- **Q7:** resolved — ≥20 sessions or one week.
- **Q8 (blast-radius warning):** keep — *unchanged*.
- **NEW Q9 — nudge default:** regex nudge on by default, or off (pure manual invocation)? *Recommend on* — it's the consent-respecting replacement for the classifier's one real service.
- **NEW Q10 — tier semantics:** keep E3/E4/E5 section templates as-is under invocation, or simplify to one ISA template? *Recommend keep as-is for M2–M3* (you know these templates; churn serves nothing), revisit post-eval.

## Decision log

- 2026-06-12 — v0.1 drafted for joint review. Repo untouched except this document.
- 2026-06-12 — v0.2 after review: **Algorithm retained as invocation-based mode** (user: "great for hard problems… makes sense for handing off labor to workers"). Classifier and forced engagement remain CUT. NEW: ISA↔seam wiring (briefs carry ISC ids; replay matches flip ISCs). M2 reshaped (classifier off + invocation entry). Size target revised 9–12k → 12–15k. Q9/Q10 opened; Q4 now evidence-conditional; Q7 resolved.
