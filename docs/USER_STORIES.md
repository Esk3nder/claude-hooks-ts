# User Stories — claude-hooks-ts

This document is the canonical backlog for closing the architectural gaps identified by the post-#46 re-audit and the core-flow verification on 2026-05-19. Each story is sized to ship as a single focused PR.

**Status legend:** `🔴 not started` · `🟡 in flight` · `🟢 shipped`

**Format:** Each story carries acceptance criteria, implementation notes with `file:line` anchors against branch `fix/audit-sprint-d1235d6` (post-PR-#48), test pattern, LOC estimate, and a risk note.

---

## Dependency graph

Build sequence — each node depends on its incoming edges landing first. Status is updated inline as stories ship so the graph doubles as a live progress board.

```mermaid
graph LR
  classDef done fill:#1e3a1e,stroke:#3a7d3a,color:#dfe7df;
  classDef flight fill:#3a311e,stroke:#9d7d2e,color:#f0e7d0;
  classDef todo fill:#1a1a1a,stroke:#4a4a4a,color:#cfcfcf;

  US3["US-3 classifier inflation guard"]:::done
  US4["US-4 source-ledger v2"]:::done
  US1["US-1 TDD-first PreToolUse gate"]:::done
  US2["US-2 mandatory worker delegation E4+"]:::done
  US1b["US-1b worker session-state inheritance for TDD"]:::todo
  US1c["US-1c worker verification replay (P0)"]:::todo
  US3b["US-3b structured floor telemetry"]:::todo
  US3c["US-3c classifier deflation guard (P0)"]:::todo
  US14["US-14 ISC checkbox probe-provenance (P0)"]:::todo
  US15["US-15 spec-vs-implementation drift check (P1)"]:::todo
  US16["US-16 tdd-suggest CLI (P1)"]:::todo
  US17["US-17 outcome telemetry at SessionEnd (P2)"]:::todo
  US18["US-18 doctrine-consistency check in doctor (P2)"]:::todo
  US5["US-5 token-level deny-list"]:::todo
  US6["US-6 regenerate-skipped telemetry"]:::todo
  US7["US-7 cross-session worker context"]:::todo
  US8["US-8 skills manifest"]:::todo
  US9["US-9 D1 ISA scoping"]:::todo
  US10["US-10 D2 LCP stanza"]:::todo
  US11["US-11 D6 helper shape"]:::todo
  US12["US-12 CORE_FLOW.md"]:::todo
  US13["US-13 doctor gate report"]:::todo

  US1 --> US1b
  US2 --> US1b
  US2 --> US1c
  US3 --> US3b
  US3 --> US3c
  US1 --> US14
  US14 --> US15
  US1 --> US16
  US4 --> US8
  US2 --> US7
  US13 --> US18
  US1 --> US12
  US2 --> US12
  US4 --> US12
  US1 --> US13
  US2 --> US13
  US3 --> US13
  US4 --> US13
```

**Reading the graph:** an arrow `A --> B` means *B should not ship before A is merged on `main`*. Stories with no incoming arrows are independent and can ship in parallel. The four Theme A pillars (US-1 → US-4) are the foundation; downstream stories light up as they land.

**Live shipped/in-flight (auto-update on every story PR):**
- 🟢 US-3 (PR #50, merged 2026-05-19)
- 🟢 US-4 (PR #51, merged 2026-05-19)
- 🟢 US-1 (PR #52, merged 2026-05-19)
- 🟢 US-2 (PR #54, merged 2026-05-19)
- 🔴 everything else (US-1b unblocked next)

---

## Theme A — Core flow enforcement (the "design promise" stories)

These four stories collectively make the repo's enforced flow match the marketing-page promise: **RPI methodology + TDD + leveraged workers**, end-to-end, codified.

### US-1 — TDD-first PreToolUse gate 🟢

> **As** a senior engineer relying on hooks to keep an agent honest,
> **I want** writes to non-test source files denied unless a matching test was touched in the same task,
> **So that** TDD is a property of the system, not an instruction the model can ignore.

**Acceptance criteria**
1. New policy module `src/policies/tdd-gate.ts` returns `{ kind: "allow" | "deny" | "ask" }` given `{ toolName, resolvedFilePath, lastTestTouchedAt, tddGateEnabled }`.
2. The gate fires for `Write`, `Edit`, `MultiEdit`, `NotebookEdit` on paths under `src/**` when the inferred companion test (`test/**/<name>.test.ts` or `<file>.test.ts`) does not exist OR has not been modified in the current task.
3. The gate is **opt-in** by `tddGateEnabled` (default `false`) — never silent escalation.
4. Bootstrap escape: when the same tool call batch creates both the test file and the implementation file (PreToolUse sees the test path appear in `files_changed` for the same `session_id`), the write is allowed.
5. Regression tests pin all four cases: src-without-test (deny), src-with-stale-test (deny), src-with-fresh-test (allow), bootstrap batch (allow).

**Implementation notes**
- Pure logic lives in `src/policies/tdd-gate.ts`, modeled on `src/policies/engagement-gate.ts:54-62`.
- Wire from `src/events/pretool-policy.ts:39-56` (insert in `collectPathPolicies` chain after `engagement-gate`, before tool evaluation at `:246-251`).
- Extend `EngagementState` in `src/schema/session-state.ts` with `last_test_touches?: Record<string, string>` (filepath → ISO ts). Update by `src/events/post-edit-quality.ts` on every Edit/Write whose target matches `*.test.ts`.
- Companion-test inference helper `inferTestPath(srcPath: string): string[]` — return both `test/<rel>.test.ts` and inline `<dir>/<name>.test.ts` candidates. Keep alongside `tdd-gate.ts` for testability.
- Config flag in `src/services/runtime-config.ts` and `.claude-hooks/runtime.yaml`. Document in README "Config" section.

**Test pattern**
- Unit tests: `test/policies/tdd-gate.test.ts` — pure `test.each` matrix on `evaluateTddGate()` mirroring `test/policies/engagement-gate.test.ts:1-150`.
- Integration test in `test/events/pretool-policy.test.ts` — assert decision threading.

**LOC estimate**: ~250 (policy 80, schema field 10, post-edit recorder 20, pretool wiring 30, tests 110)

**Risk** (T10/T1): blocking the very first test-creation Write. Mitigated by (a) bootstrap-batch check above and (b) gate disabled by default. Reviewers must verify the batch escape.

---

### US-1b — Worker session-state inheritance for TDD (and provenance) 🔴

> **As** a user delegating implementation to a worker after authoring the test in the parent session,
> **I want** the worker's session-state to inherit the parent's `files_changed` ledger at `SubagentStart`,
> **So that** the TDD gate (US-1) recognizes the parent-written test as a "companion test touched in this session" and lets the worker write the implementation.

**Why this exists (gap discovered after US-1 verification)**
- Workers run with their own `session_id` (`src/events/subagent-scope-gate.ts:24-27`); their `SessionState.files_changed` is independent of the parent's.
- Today, after parent writes `test/foo.test.ts`, spawning a worker to write `src/foo.ts` triggers the TDD gate because the worker's own `files_changed` is empty.
- `worker-runs.ts:22` already carries `parent_task_id` linkage — the plumbing exists; only the inheritance is missing.

**Acceptance criteria**
1. In `src/events/subagent-scope-gate.ts:handleSubagentStart` (~L260): when the `SubagentStart` event arrives, look up the parent's `SessionState.files_changed` and seed the worker session's record with the same list (as `inherited_files_changed: ReadonlyArray<string>` if we want to keep provenance separate, OR by merging into `files_changed` directly).
2. The TDD gate (`src/policies/tdd-gate.ts`) consults the merged list (or both lists) when checking the bootstrap-batch escape.
3. New tests: worker spawned after parent wrote test → TDD gate allows; worker spawned with no parent test → TDD gate denies (regression of US-1 behavior).
4. Provenance preserved: the gate's allow reason names which file matched (parent vs. worker-local).
5. No leak in the other direction — the parent's session-state must not absorb the worker's changes (one-way inheritance).

**Implementation notes**
- Smallest correct change: copy `parent.files_changed` into `worker.files_changed` at `SubagentStart`. Lose nothing; gain bootstrap escape across the parent/worker boundary.
- Cleaner: add `inherited_files_changed?: ReadonlyArray<string>` to `SessionStateRecord` schema and have the TDD gate check both arrays. Preserves provenance and avoids confusing PostToolUse handlers that key off "did *this session* change file X".
- Risk: the parent's session-state may not exist yet on the worker host when `SubagentStart` fires (sessions can be hosted by separate hook processes if cross-machine). Mitigate: best-effort lookup, swallow failures (the worker just falls back to its own ledger, current behavior).

**Test pattern**: `test/events/subagent-scope-gate.test.ts` — extend with TDD-gate-aware integration cases. Mock parent session state via `SessionStateTest()`.

**LOC estimate**: ~120 (schema 10, gate read-merge 20, subagent-scope-gate seeding 30, tests 60).

**Risk** (additional): if a worker is spawned in a session group where the parent's tests are intentionally NOT meant to count (e.g. an explicit *new* feature in the worker's scope), inheritance could allow a write that would have been denied. Mitigated by US-1's opt-in posture (`tddGateEnabled: false` by default) — operators turning it on are signaling they want this behavior.

---

### US-1c — Worker behavioral verification replay (P0) 🔴

> **As** a parent session delegating implementation to a worker,
> **I want** the worker's claimed `verification` (typecheck/tests/lint passes) to be re-run in the parent process at `SubagentStop` before the worker's output is accepted,
> **So that** "the worker said it passed" stops being a trust statement and becomes a verifiable claim.

**Why this exists**
- Worker output schema (`src/schema/worker-run.ts`) requires `verification: { name, status, ... }[]` but the worker reports its own results. Nothing in the parent re-runs them.
- A worker can claim `typecheck: "pass"` without ever invoking `tsc`. The parent has no idea.
- This is the largest single verifiability gap in the "leveraged workers" pillar.

**Acceptance criteria**
1. New `src/events/subagent-replay-verify.ts` invoked from `handleSubagentStop` (`src/events/subagent-scope-gate.ts:307`).
2. For each `verification[]` entry in the worker's output, look up a matching probe in `.claude-hooks/probes.ts` and re-run it in the parent's cwd.
3. If any replayed probe disagrees with the worker's claim → emit a `decision: "block"` with a `verification_replay_failed` reason that names the disagreeing probe + claimed vs. actual.
4. Best-effort: missing probes are logged but do not block (treated as unverifiable, not unverified).
5. Tests: worker claims `typecheck: pass` but probe returns false → SubagentStop blocks; worker claims pass and probe also passes → no-op; missing probe → warning, no block.

**Implementation notes**
- Reuse the existing probe loader from `src/algorithm/isa/probes.ts` (already hot-loaded at PostToolUse).
- Run replays in parallel with `Effect.all` (no inter-probe dependencies).
- Honor the same per-probe `timeoutMs` from the loader.
- The replay surface is independent from the existing `recordWorkerStop` evidence check — that gate ensures the worker SAID something; this gate ensures what it said is true.

**Test pattern**: `test/events/subagent-replay-verify.test.ts` mirroring the structure of `test/events/subagent-scope-gate.test.ts`. Use the existing `WorkerRuns` + `SessionState` test layers; mock probes via a thin fake module.

**LOC estimate**: ~280 (handler 110, schema + types 20, tests 150).

**Risk**: probe re-run cost on every SubagentStop. Mitigated by parallelism + the existing 1s per-probe cap. Catastrophic: a divergent probe blocks a worker that genuinely succeeded — guard with an explicit "replay disagreement" reason so the model can investigate, not be left guessing.

---

### US-2 — Mandatory worker delegation at tier ≥ E4 🟢

> **As** the owner of a multi-hour deep-work session,
> **I want** direct `Write`/`Edit`/`Bash`-write tool calls denied (or transparently rewritten into `Task`/`Agent` launches) at classifier tier E4+,
> **So that** parallel subagent work — already advertised in the README — actually happens instead of being optional.

**Acceptance criteria**
1. New policy `src/policies/worker-mandatory.ts` exporting `evaluateWorkerMandatoryGate({ toolName, lastTier, activeWorkerCount, gateMode })` → `allow | ask | deny`.
2. Three `gateMode` settings: `"off"` (default), `"recommend"` (`ask` with a reason), `"strict"` (`deny` with remediation hint to spawn an Agent).
3. Triggers only when `last_tier >= 4` AND the tool is a direct write (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`/`Bash` with write-class verbs).
4. Active worker count tracked in `EngagementState.active_worker_ids: string[]` — appended on `SubagentStart`, removed on `SubagentStop`. While at least one worker is active, the gate passes (workers can write).
5. Tests cover: E3 prompt → passthrough; E4 prompt with no active worker → deny in `strict`, ask in `recommend`; E4 prompt with active worker → allow.

**Implementation notes**
- Pure logic alongside other policies in `src/policies/`.
- Hook into `src/events/pretool-policy.ts:227-237` (immediately after engagement-gate).
- Track active workers by extending `src/events/subagent-scope-gate.ts` to mutate `EngagementState.active_worker_ids` on the `SubagentStart`/`SubagentStop` paths (see lines ~91-150 today for worker output handling).
- Config flag `worker_mandatory_mode: "off" | "recommend" | "strict"` in `src/services/runtime-config.ts`.
- The Agent launch remediation message should reference `src/policies/worker-contract.ts:39-45` so the model knows the contract.

**Test pattern**: `test/policies/worker-mandatory.test.ts` — `test.each` matrix on `(tier, toolName, activeWorkers, mode) → decision`.

**LOC estimate**: ~300 (policy 90, subagent-scope-gate state mutation 60, pretool wiring 30, schema 10, tests 110)

**Risk** (T10/T2): forcing delegation on a fast E4 turn surprises the user. Mitigated by `gateMode: "recommend"` as the rollout default; `strict` reserved for explicit opt-in.

---

### US-3 — Classifier tier-inflation guard (D4) 🟢

> **As** a user typing short prompts in the middle of a session,
> **I want** the classifier to NOT escalate a one-line ack to E3/E4/E5 just because the rubric defaults aggressive,
> **So that** ISA ceremony only happens when the prompt actually has the structural evidence to warrant it.

**Acceptance criteria**
1. New `src/algorithm/classifier-inflation-guard.ts` exporting `checkStructuralEvidence({ prompt, context, tier })` → `{ pass: boolean; floorTier: 1|2|3 }`.
2. Heuristic: tier ≥ E4 passes only if the prompt OR recent context contains at least one of: a code block, ≥3 file paths, an explicit "multi-step" / "cross-cutting" / "architecture" verb, or an existing engagement ISA referenced.
3. When the guard fails, the tier is floored to E3 (still ALGORITHM, still gets an ISA) — never demoted below E3 since that would skip engagement entirely.
4. Telemetry record `{ original_tier, normalized_tier, reason }` written to `mode-classifier.jsonl` via the existing `ClassifierTelemetry` service.
5. Tests: a "wall of text but no code" prompt classified E5 by Sonnet → floored to E3; a short prompt with `src/foo.ts` reference and tier E4 → kept at E4.

**Implementation notes**
- Insert normalization in `src/services/inference.ts` after `parseClassifierResponse()` returns (~line 165).
- Reuse the existing `getRecentContext()` plumbing at `src/algorithm/transcript-context.ts`.
- Reuse the `hasCodeContextInRecent` helper from `src/algorithm/classifier.ts:141` for one of the evidence signals (DRY).
- No schema change required; only the normalized tier flows downstream.

**Test pattern**: `test/algorithm/classifier-inflation-guard.test.ts` — pure `test.each` matrix on `(prompt, context, tier) → { pass, floorTier }`.

**LOC estimate**: ~180 (guard 70, inference normalization 20, telemetry field 10, tests 80)

**Risk** (T10/T3): under-classifying a genuinely deep task that happens to be tersely phrased. Mitigated by ORed signals and an audit log so false-negatives are observable.

---

### US-3c — Classifier deflation guard (P0) 🔴

> **As** a user who typed a long, structurally rich prompt that the classifier collapsed to MINIMAL or NATIVE,
> **I want** the classifier output to be ESCALATED to ALGORITHM-E1 (engaged) when the prompt or recent context shows the same structural signals US-3 uses for floor-up,
> **So that** under-classification doesn't strand a real change without ceremony — the symmetric counterpart to US-3.

**Why this exists**
- US-3 (`src/algorithm/classifier-inflation-guard.ts`) only floors tier 4/5 → 3 when evidence is absent. It NEVER promotes a low-tier verdict.
- Under-classification silently bypasses RPI, TDD, worker-mandatory — every methodology pillar.
- The signal set already exists: `hasStructuralSignal` returns true for code fences, ≥3 file paths, structural verbs, ISA refs.

**Acceptance criteria**
1. Extend `src/algorithm/classifier-inflation-guard.ts` with `checkUnderClassification({ prompt, context, mode, tier })` → `{ pass: boolean; floorMode?: "ALGORITHM"; floorTier?: 1 }`.
2. Triggers when `mode` is MINIMAL or NATIVE AND `hasStructuralSignal(prompt) || hasStructuralSignal(context)`.
3. When the guard fires, classification is rewritten to `mode: ALGORITHM, tier: 1, reason: "<orig> [deflation-guard: structural evidence present]"`.
4. Wired in `src/services/inference.ts` immediately after the existing inflation guard call (so floor + ceiling normalization happen in one pass).
5. Tests: praise-shape prompt with no code → MINIMAL passthrough; "fix the typo on `foo.ts`" → escalated to E1; "thanks" with prior turn containing a code block → escalated (catches the praise-after-code case the inflation guard already worries about).

**Implementation notes**
- Reuse `hasStructuralSignal` from US-3's file — no new helper needed.
- Choose **E1 not E3** as the floor — E3 forces ISA ceremony which is too heavy for "fix the typo on foo.ts". E1 still triggers engagement-related context but is the lightest ALGORITHM tier.
- Symmetric design: floor down to E3 (US-3) and floor up to E1 (US-3c) — never crosses the boundary in the wrong direction.

**Test pattern**: extend `test/algorithm/classifier-inflation-guard.test.ts` with a `describe("checkUnderClassification ...")` block, ~10 cases.

**LOC estimate**: ~120 (guard 40, inference wiring 15, tests 65).

**Risk**: false-escalation of brief acks that happen to contain a slash idiom. Mitigated by reusing the same conservative `hasStructuralSignal` and not adding new false-positive surface.

---

### US-4 — Source-ledger gate v2: workflow-tag scoping 🟢

> **As** an engineer doing coding work that incidentally mentions "current best practices",
> **I want** the source-ledger gate suppressed for confidently-tagged non-research workflows,
> **So that** the gate stops blocking legitimate code turns while still catching prompts that explicitly invoke web research.

**Shipped in PR #51 (2026-05-19).** Note: design refined during implementation versus the original spec — see Decisions below.

**Final acceptance criteria (shipped)**
1. `WEB_SOURCES_REQUIRED` in `src/policies/workflow-classifier.ts` split into STRONG and WEAK tiers.
2. `requiresWebSources(prompt, workflow?)` takes an optional `WorkflowTag` argument.
3. When `workflow` is supplied and is **not** `"unknown"` (including `research.*`), only STRONG patterns fire — loose priming tags must not force the ledger.
4. When `workflow` is `"unknown"` or absent, the combined STRONG+WEAK set fires (belt-and-suspenders, original behavior).
5. STRONG patterns: explicit invocations (`search the web`, `google for X`, `cite the sources`, `pull current benchmark data`, `latest news on/in`, `online research`, `web research`).
6. WEAK patterns: common-English idioms that misfire on coding/writing/ops (`current best practices`, `state of the art`, `recent news/updates`).
7. PR-#48's ISA frontmatter opt-out continues to override at the Stop gate downstream.
8. `prompt-router.ts:103` passes the existing regex-derived `workflow` tag from `classifyPrompt` — no Sonnet rubric change, no `Classification` schema change.

**Design deviation from original spec**
- Original spec said `research.* → true` (always force ledger on research workflows). This broke the existing decoupling contract pinned by `test/events/prompt-router.test.ts` ("persists requires_web_sources=false for a loose research.web priming match"). Loose `research.web` priming from "look up my notes" must NOT force the ledger.
- Final design: all confidently-tagged workflows (including `research.*`) are STRONG-only. The ledger fires only when the prompt **explicitly** invokes web research.

**Files (shipped)**
- `src/policies/workflow-classifier.ts` — split patterns, extend signature
- `src/events/prompt-router.ts` — pass workflow tag through
- `test/policies/workflow-classifier.test.ts` — 19 new tests

**Actual LOC**: +140 / -3.

---

## Theme B — Gate hardening (post-audit cleanup)

### US-5 — Token-level deny-list for inspection whitelist 🔴

> **As** an operator extending the inspection whitelist,
> **I want** the loader to reject destructive commands by parsing argv tokens, not by substring match,
> **So that** false positives like `rmdir`/`bashrc` don't waste config attempts and false negatives don't slip dangerous commands through.

**Acceptance criteria**
1. New `src/services/shell-words.ts` exporting `tokenizeCommand(cmd: string): string[]` (quote-aware) and `parseCommandVerb(tokens): string | null`.
2. `src/policies/inspection-whitelist.ts:1-142` refactored to compose `tokenizeCommand` + a token-level deny set.
3. Token deny set: `rm`, `mv`, `cp`, `chmod`, `chown`, `kill`, `dd`, `tee`, `sudo`, `curl`, `wget`, `sh`, `bash`, `zsh`, `eval`, `exec`, `source`, `>`, `>>`, `<`, `&&`, `||`, `;`, `|`, `$(`, `` ` ``.
4. Add a flipped predicate-allowlist style as an alternative: `allowedVerbs: ["ls", "pwd", "git", "find", "rg"]` for users who want strict opt-in.
5. Regression tests cover `rmdir` (allow — not a destructive verb), `bashrc` (allow — not the `bash` verb), `rm -rf` (deny), `ls && rm` (deny via control char).

**Implementation notes**
- Lift the existing `DESTRUCTIVE_VERBS` and `SHELL_CONTROL_RE` constants from `inspection-whitelist.ts` and re-express against tokens.
- Reuse this tokenizer in `src/policies/destructive-commands.ts:7-67` to retire its bespoke regex set in a follow-up.

**Test pattern**: `test/services/shell-words.test.ts` + new cases in `test/policies/inspection-whitelist.test.ts`.

**LOC estimate**: ~220 (tokenizer 80, whitelist refactor 60, tests 80)

**Risk** (T10/T5): the tokenizer becomes attack surface itself. Mitigated by keeping the deny-list strict and adding fuzz cases.

---

### US-6 — Structured regenerate-skipped telemetry 🔴

> **As** the maintainer reviewing why a Stop didn't refresh some derived artifact,
> **I want** a dedicated JSONL stream recording every `regenerate-skipped` event with rule names and budget reason,
> **So that** the operations team has machine-readable evidence, not just a `logWarning` line.

**Acceptance criteria**
1. New `src/services/regenerate-telemetry.ts` mirroring `src/services/classifier-telemetry.ts:1-141`.
2. New schema `RegenerateSkippedRecord` in `src/schema/events.ts` with `{ timestamp, session_id, skipped_rules: string[], reason }`.
3. Stream written to `.claude-hooks/state/observability/regenerate-skipped.jsonl`.
4. `src/events/stop-definition-of-done.ts:359-361` invokes telemetry alongside the existing session-state write.
5. Test in `test/services/regenerate-telemetry.test.ts` mirrors `test/services/classifier-telemetry.test.ts` (in-memory test layer).

**Implementation notes**
- Reuse `EventStoreLive` from `src/services/event-store.ts:365-429`.
- Best-effort append — failures swallowed, never block Stop.

**LOC estimate**: ~180 (service 70, schema 20, stop-handler wiring 10, tests 80)

**Risk** (T10/T6): silent telemetry failure hides skip events. Mitigated by stderr warning on append failure (same pattern as classifier-telemetry).

---

### US-7 — Cross-session worker context injection 🔴

> **As** a user resuming a session that spawned long-running workers,
> **I want** the parent session to see a one-paragraph summary of completed worker output in `additionalContext`,
> **So that** the leverage promised by the worker architecture actually compounds across turns.

**Acceptance criteria**
1. `src/services/worker-aggregation.ts` extends `WorkerIntegrationSummary` with `additional_context_fragments: string[]`.
2. New module `src/events/cross-session-worker-context.ts` queries `WorkerAggregation` on `UserPromptSubmit` and returns a context fragment if at least one worker completed since the last prompt.
3. Fragment format: `"Worker(s) completed since last turn: <bullet list of summaries, max 3, truncated at 240 chars each>"`.
4. Only completed/failed runs included; running/pending excluded.
5. Test in `test/events/cross-session-worker-context.test.ts` uses `WorkerRuns` test layer to inject mock runs.

**Implementation notes**
- Plumb the fragment through `src/events/prompt-router.ts` near the existing `regenSkippedLine` logic (~line 207-217 today).
- Reuse `summarizeParent()` from `worker-aggregation.ts`.

**LOC estimate**: ~240 (aggregation extension 60, new handler 70, router wiring 30, tests 80)

**Risk** (T10/T7): stale worker context if the user opens a fresh task. Mitigated by only including runs with `completed_at > session_started_at` of the current session.

---

### US-8 — Skills manifest with workflow tags 🔴

> **As** an admin curating a team's skill bundle,
> **I want** a `.claude-hooks/skills-manifest.yaml` mapping each skill to one or more workflow tags,
> **So that** the prompt-router can surface a "consider invoking skill X" hint when the classifier returns a matching workflow.

**Acceptance criteria**
1. Manifest schema in `src/schema/skills-manifest.ts`: `{ skills: Array<{ name: string; workflow_tags: WorkflowTag[]; description?: string }> }`.
2. Loader in `src/services/skill-manifest.ts` reads from `<projectRoot>/.claude-hooks/skills-manifest.yaml` (optional file).
3. Pure matcher `src/policies/skills-workflow.ts` exporting `matchSkillsByWorkflow(manifest, workflow)`.
4. `src/events/prompt-router.ts` injects a one-line context: `Consider skill(s): <names>` when matches exist.
5. Tests cover parse, match, fallback when manifest missing.

**Implementation notes**
- Cache manifest in `SessionState` (`skill_manifest_cache?: ManifestRecord`) to avoid re-reads per prompt.
- Fall back to directory scan of `~/.claude/skills/_bundled/` only if explicit opt-in flag set.

**LOC estimate**: ~260 (schema 30, loader 80, matcher 30, router 20, tests 100)

**Risk** (T10/T8): manifest drift. Mitigated by manifest being optional and the prompt being a hint, not a directive.

---

## Theme C — PR-#48 review debt (smaller follow-ups)

### US-9 — D1 opt-out: scope to engaged ISA only 🔴

> **As** a user with both a task ISA and a project ISA active,
> **I want** the `source_ledger_opt_out` flag set only when the engaged ISA's frontmatter declares it,
> **So that** edits to an unrelated project ISA don't clobber a task-scoped opt-out (the PR-#48 review-debt item).

**Acceptance criteria**
1. `src/events/post-edit-quality.ts` only updates `source_ledger_opt_out` when the edited ISA path matches `record.expected_isa_path_absolute`.
2. New regression test asserts: opt-out persists when an unrelated ISA is edited mid-session.

**Implementation notes**: see review comment in PR #48; tiny patch in `post-edit-quality.ts` after `isIsaEdit` branch.

**LOC estimate**: ~50 (logic 15, tests 35)

**Risk**: very low.

---

### US-10 — D2 stanza: derive source glob from changed-files LCP 🔴

> **As** a user adding a verify-map rule on the prompt of the D2 message,
> **I want** the suggested `source:` glob to reflect what actually changed,
> **So that** the stanza is useful out-of-the-box on non-TS repos.

**Acceptance criteria**
1. Compute longest common path prefix from changed files; emit as `source: "<lcp>/**"`.
2. Default the `command:` to `"<your-test-command>"` rather than a node-specific guess.
3. Test confirms LCP across mixed extensions and across single-file changes.

**Implementation notes**: edit in `src/events/stop-definition-of-done.ts` no-rule fallback (currently builds a hard-coded stanza).

**LOC estimate**: ~80 (helper 30, wiring 10, tests 40)

**Risk**: low.

---

### US-11 — D6 v2: rationalize `recentTurns` shape 🔴

> **As** a maintainer of `classifier.ts`,
> **I want** `hasCodeContextInRecent` to accept `recentTurns: string[]` (the conceptual model in the spec) and to be reusable by US-3,
> **So that** the helper composes cleanly with the inflation guard without string-juggling.

**Acceptance criteria**
1. Helper accepts `string | string[]` (join internally) — backward compatible.
2. Add tests covering both shapes.
3. Update US-3's guard to share this helper.

**LOC estimate**: ~60.

**Risk**: very low.

---

## Theme D — Documentation & developer-experience

### US-12 — End-to-end RPI flow documentation 🔴

> **As** a new contributor opening this repo,
> **I want** `docs/CORE_FLOW.md` to walk the exact lifecycle from `UserPromptSubmit` → `Stop` with file:line anchors,
> **So that** the "RPI/ISA methodology, TDD, leveraged workers" claim is grounded in code, not in marketing copy.

**Acceptance criteria**
1. New doc enumerates the 6 phases verified in this session's core-flow audit (prompt-router → engagement-gate → PreToolUse deny → ISA write → PostToolUse probes → Stop completeness).
2. Each phase carries one paragraph and at least one `file:line` anchor.
3. Doc links forward to US-1, US-2, US-3, US-4 as the gap-closing roadmap.

**LOC estimate**: ~250 lines of markdown.

**Risk**: drift. Mitigated by linking line ranges (not exact lines) and including a "verified against commit X" footer.

---

### US-13 — `claude-hooks-doctor` extended checks 🔴

> **As** an operator deploying claude-hooks-ts on a fresh machine,
> **I want** `claude-hooks-doctor` to report which optional gates (TDD, worker-mandatory, source-ledger-v2) are currently active and what config drives each,
> **So that** I can confirm the install reflects the intended posture without grepping source.

**Acceptance criteria**
1. `claude-hooks-doctor --verbose` lists each gate name, active mode, and config file that controls it.
2. `--json` output includes the same data structured.
3. Test extension in `test/bin/doctor.test.ts` (or wherever the doctor is currently tested).

**LOC estimate**: ~180.

**Risk**: low.

---

## Theme E — System verifiability (gap stories from the post-merge meta-audit)

The four Theme A pillars enforce *behavior*. Theme E closes the gaps that let a model *fake* compliance with that behavior — the moves the system is currently still trusting on faith.

### US-14 — ISC checkbox probe-provenance (P0) 🔴

> **As** a maintainer trusting the Stop completeness gate,
> **I want** ISC checkboxes that were flipped by a probe distinguishable from ones flipped by the model via `Edit`,
> **So that** "all ISCs checked" is a verifiable claim, not a model self-assertion.

**Why this exists**
- Today `[ ]` → `[x]` can be done by either the probe (`src/algorithm/isa/probes.ts` flipping after a real pass) or by the model writing `Edit` to the ISA file.
- The Stop completeness gate (`src/algorithm/isa/completeness.ts`) only reads checkbox state. It cannot distinguish "verified" from "asserted."
- Combined with US-15, this makes the ISA stop being a self-attestation document.

**Acceptance criteria**
1. Probe-flipped checkboxes use a distinguishable marker: `- [x]` for model edits, `- [x:probe]` for probe-flipped (or stored separately in session-state as a `probe_verified_iscs: ReadonlyArray<string>` field; pick one).
2. ISA's `## Test Strategy` table grows a `requires_probe` column (default false). When true, the corresponding ISC under `## Criteria` must have probe-provenance at Stop time, not model-provenance.
3. Stop completeness gate (`completeness.ts:70-91`) blocks if any `requires_probe: true` ISC was checked without probe provenance.
4. PostToolUse-driven probe pass writes the marker; model `Edit` flipping a `[ ]` does NOT write the marker.

**Implementation notes**
- Two storage options: (a) inline `[x:probe]` marker in the ISA — visible, fragile to model edits; (b) session-state `probe_verified_iscs` field — invisible to model, robust. Recommend (b).
- Stop gate enrichment: when reading completeness, intersect `Test Strategy` rows with `requires_probe: true` and require those ISCs in the session-state list.

**Test pattern**: extend `test/algorithm/isa/completeness.test.ts` with provenance cases; new `test/services/session-state.test.ts` cases for the new field.

**LOC estimate**: ~220.

**Risk**: false-failure when a probe really did pass but the marker wasn't recorded (e.g., probe pass on the LAST tool call before Stop — race). Mitigated by always running probes synchronously in PostToolUse.

---

### US-15 — Spec-vs-implementation drift detection (P1) 🔴

> **As** a reviewer trusting "all Features shipped",
> **I want** Stop to confirm that each `## Features` entry that names a file/module corresponds to a file in `record.files_changed`,
> **So that** a model declaring 5 features and shipping 3 cannot pass completeness by checking 5 boxes.

**Acceptance criteria**
1. Parse `## Features` entries from the active ISA at Stop time. For entries that contain a `path/like/this.ts` or `module/foo` token, extract the path.
2. For each extracted path, confirm at least one matching file appears in `record.files_changed` (substring match against the ISA-named token).
3. Stop blocks with a `feature_implementation_missing` reason listing unmet features.
4. Soft mode (default): warns in additionalContext instead of blocking. Strict mode (`CLAUDE_HOOKS_FEATURE_DRIFT_STRICT=1`) blocks.

**Implementation notes**
- Path extraction is a simple regex on Feature bullet text.
- Hook into `src/events/stop-definition-of-done.ts` near the existing completeness check.
- Coexists with US-14: provenance proves checkboxes are real; drift detection proves features were actually implemented.

**LOC estimate**: ~180.

**Risk**: features that DON'T name a file (pure-doc, pure-refactor) get a free pass — acceptable; the goal is catching obvious skips, not perfect coverage.

---

### US-16 — `claude-hooks-tdd suggest <file>` CLI (P1) 🔴

> **As** a model that just hit the TDD gate deny,
> **I want** a CLI subcommand that prints candidate companion-test paths AND a starter template,
> **So that** I can comply without guessing or trial-and-error.

**Acceptance criteria**
1. New `bin/claude-hooks-tdd` subcommand (or extend `claude-hooks-doctor`): `claude-hooks-tdd suggest src/foo/bar.ts`.
2. Prints the inferred candidate paths (from `inferTestPaths`) plus a minimal `describe(...) { test(...) {...} }` skeleton matching the project's existing test style (Bun's `import { describe, expect, test } from "bun:test"`).
3. The TDD gate's deny message references this command.
4. Tests: snapshot test of CLI output for a sample input.

**Implementation notes**
- Reuse `inferTestPaths` from `src/policies/tdd-gate.ts`.
- Detect test framework from `package.json` (bun:test, vitest, jest) and emit matching skeleton. Default to bun:test.

**LOC estimate**: ~140 (CLI 80, tests 60).

**Risk**: very low.

---

### US-17 — Outcome telemetry at SessionEnd (P2) 🔴

> **As** a maintainer asserting the methodology produces better outcomes,
> **I want** session-level outcome telemetry at SessionEnd,
> **So that** we can measure whether sessions that hit the gates correlate with better outcomes vs. sessions that bypass them.

**Acceptance criteria**
1. SessionEnd handler records to `.claude-hooks/state/observability/sessions.jsonl`: `{ session_id, started_at, ended_at, classifier_tier, mode, gates_fired: { engagement, tdd, worker_mandatory, source_ledger }, isa_completed, files_changed_count, subagent_count }`.
2. Optional outcome hook: if `.claude-hooks/outcome-hook.sh` exists, called with the session record; its stdout becomes the `outcome` field (e.g., "merged", "reverted", "abandoned").
3. New `claude-hooks-stats` CLI for ad-hoc reading: `claude-hooks-stats --since 7d` shows aggregate gate trigger rates and outcomes.

**Implementation notes**
- The record is the same shape the dispatcher could feed to OTLP later; design it to be Honeycomb-shaped.
- Outcome hook is OPTIONAL because defining "good outcome" is a research question, not just plumbing.

**LOC estimate**: ~300 (handler + service 150, CLI 80, tests 70).

**Risk**: privacy. Telemetry is local-only by default; OTLP export is explicit opt-in. Document the schema so users know exactly what's recorded.

---

### US-18 — Doctrine-consistency check in `claude-hooks-doctor` (P2) 🔴

> **As** an operator with a CLAUDE.md that says "skip the TDD gate" while my runtime config has `CLAUDE_HOOKS_TDD_GATE_ENABLED=1`,
> **I want** `claude-hooks-doctor --verbose` to flag the contradiction,
> **So that** the methodology can't be silently undermined by an out-of-date instructions file.

**Acceptance criteria**
1. New consistency module checks: does `~/.claude/CLAUDE.md` or `<project>/CLAUDE.md` text contain phrases like "skip TDD", "no test required", "no worker", etc. while the corresponding gate is enabled?
2. `claude-hooks-doctor --verbose` lists each contradiction as `WARN doctrine_drift: ...`.
3. `--json` includes them as a `doctrine_drift[]` field.
4. Phrase set is conservative; false positives are noisier than false negatives so the bar is "obvious contradiction," not "any tension."

**LOC estimate**: ~160.

**Risk**: brittle regex on user prose. Mitigated by being conservative and listed only at `--verbose`.

---

## Suggested ship order

1. ✅ **US-3** (classifier guard) — shipped (PR #50)
2. ✅ **US-4** (source-ledger v2) — shipped (PR #51)
3. ✅ **US-1** (TDD gate) — shipped (PR #52)
4. ✅ **US-2** (mandatory worker delegation E4+) — shipped (PR #54)
5. **US-1c** (worker verification replay) — **highest-value remaining**. Closes the biggest verifiability hole in the workers pillar. Depends on US-2.
6. **US-14** (ISC probe-provenance) — companion to US-1c at the parent level. Depends on US-1.
7. **US-3c** (classifier deflation guard) — symmetric counterpart to US-3. Depends on US-3.
8. **US-1b** (worker session-state inheritance) — unblocks worker compliance with US-1's gate.
9. **US-15** (spec-vs-implementation drift) — completes the completeness story alongside US-14.
10. **US-16** (tdd-suggest CLI) — UX paint after US-1 has caused enough friction to motivate.
11. **US-12** (CORE_FLOW.md) — write the truth doc after US-1c + US-14 land (otherwise the doc has known liabilities to disclose).
12. **US-5** → **US-9** → **US-10** → **US-11** — gate hardening in priority order.
13. **US-3b** (structured floor telemetry) — deferred follow-up to US-3 ISC-4.
14. **US-6** → **US-7** → **US-8** — observability & convenience.
15. **US-13** — capstone visibility check.
16. **US-17** (outcome telemetry) — only meaningful after enough sessions accumulate; defer.
17. **US-18** (doctrine consistency) — nice-to-have polish.

## End-to-end confirmation plan

"Methodology enforced" is not a feeling — it has to be an observable property. Below are the **concrete tests** that, when all green, constitute end-to-end proof that the system delivers what the README claims. Each test is a fixture-driven integration scenario living under `test/integration/methodology/`.

### Per-pillar gate proofs

| Test | Setup | Expected | Pillar |
| --- | --- | --- | --- |
| `e2e-rpi.test.ts` | session at ALGORITHM E3, no ISA on disk, model attempts `Write src/foo.ts` | PreToolUse denies with the engagement-gate message; after model writes ISA, the same Write is allowed | RPI |
| `e2e-tdd.test.ts` | `tddGateEnabled=true`, ISA present, model attempts `Write src/foo.ts` without companion test | deny → model writes `test/foo.test.ts` → next `Write src/foo.ts` is allowed (bootstrap-batch escape) | TDD |
| `e2e-worker-mandatory.test.ts` | `workerMandatoryMode=strict`, classifier returns E5, no active subagent, model attempts `Write src/foo.ts` | deny → model launches `Task` → subagent_starts increments → same Write is allowed | Workers |
| `e2e-worker-verification.test.ts` (post-US-1c) | worker returns `verification: { typecheck: pass }` but probe re-run returns false | SubagentStop blocks with `verification_replay_failed`, naming the disagreeing probe | Workers (real teeth) |
| `e2e-isc-provenance.test.ts` (post-US-14) | ISA has an ISC tagged `requires_probe: true`, model directly Edits `[ ]` → `[x]` without probe pass | Stop completeness blocks; only a probe-flipped checkbox satisfies it | RPI (real teeth) |
| `e2e-classifier-inflation.test.ts` | wall-of-text prompt with no code, Sonnet returns tier=5 | inference output tier floored to 3, reason includes `inflation-guard` | Right-sized ceremony |
| `e2e-classifier-deflation.test.ts` (post-US-3c) | "fix the typo on src/foo.ts:42" prompt, Sonnet returns NATIVE | inference output escalated to ALGORITHM E1 | Right-sized ceremony |
| `e2e-source-ledger-scoping.test.ts` | prompt "use current best practices for error handling" classified as `coding.fix` | session-state `requires_web_sources = false`; Stop does not block | Right-sized ceremony |
| `e2e-spec-drift.test.ts` (post-US-15) | ISA declares Features naming `src/foo.ts` and `src/bar.ts`, only `src/foo.ts` in files_changed | Stop blocks (strict mode) or warns (default) with `feature_implementation_missing` | RPI completeness |

### Methodology integration test

`test/integration/methodology/full-session.test.ts` simulates a complete E4 session end-to-end through the dispatcher:
1. UserPromptSubmit with a complex prompt → classifier returns E4 → engagement directive injected
2. PreToolUse Write to source → denied (no ISA)
3. PreToolUse Write to expected ISA path → allowed; model writes minimal ISA
4. PreToolUse Write to source → denied (no companion test, TDD enabled)
5. PreToolUse Write to test → allowed
6. PreToolUse Write to source → allowed (bootstrap-batch escape)
7. PostToolUse runs probes → ISC checkboxes flipped with probe-provenance
8. PreToolUse `Task` launch → worker contract injected, subagent_starts +=1
9. SubagentStop with claimed `verification: pass` → replayed and confirmed → subagent_stops +=1
10. Stop → completeness gate passes (provenance + features + verification all green)

Assertion: every decision at every hook fires the expected gate AND the session-state ledger at the end matches a known fixture.

### One-shot confirmation script

`scripts/confirm-methodology.sh` runs:
```bash
#!/usr/bin/env bash
set -euo pipefail
bun run typecheck
bun test test/integration/methodology/
claude-hooks-doctor --json | jq -e '.gates_active.engagement and .gates_active.tdd and .gates_active.worker_mandatory'
echo "✓ Methodology enforced end-to-end"
```

When this script exits 0, the system is confirmed delivering on the README's claims.

### What "done" looks like

The methodology system is considered **complete** when:
1. All four Theme A pillars (US-1..US-4) ✅ on main
2. US-1c, US-14, US-3c (the three P0 verifiability gaps) on main
3. `test/integration/methodology/` directory exists with all 9 fixture tests passing
4. `scripts/confirm-methodology.sh` exits 0
5. `claude-hooks-doctor --json` reports all active gates and zero `doctrine_drift[]` (post-US-18) entries
6. `docs/CORE_FLOW.md` (US-12) describes the actual flow with `file:line` anchors that match commit on main

Items 1–4 are blocking. Items 5–6 are polish.

---

## Cross-cutting acceptance bars (apply to every story)

- TypeScript strict mode kept; no `any`.
- Tests: at minimum a `test.each` matrix for the new pure function.
- Schema additions are nullable/optional and merged via `{ ...EMPTY_SESSION_STATE, ...parsed }` to preserve backward compatibility.
- New telemetry must be best-effort (failure swallowed, never blocks).
- Each PR must include `bun run typecheck`, `bun test`, and `bun run lint:claude-spawn` exit-0 in the description.
