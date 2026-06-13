# claude-hooks-ts — Implementation Spec (Full)

**Version:** 2.0 (full scope)
**Date:** 2026-06-12
**Companion:** `docs/SPEC.md` is the architecture constitution (doctrine R1–R8, the node model). This is the **build contract** for the *entire* constitution — every feature, with exact schemas, state machines, authority rules, and acceptance tests. Doctrine conflicts resolve to the constitution; mechanism conflicts resolve here.

Buildable as written. The only things not fully contracted are named in §16, and they are genuine externalities (host-version payload drift), not deferred features.

---

## 1. Scope — the whole system

### 1.1 In (everything)
Substrate · input-safety gates + capability profiles · the worker seam (brief snapshot → contract → drift → trusted replay → signed verdict → ledger) · the ISC spine with an **evidence graph** · **recursive delegation** with an authority matrix (§6) · **skeptic panels** (§7) · **intensity sampling** with distinct trust labels (§8) · **warm execution** (§9) · **speculative parallelism** with a world-fact selector (§10) · **manual-confirmation channel** (§11) · the **full 29-event surface** (§12) · report + conformance doctor. No feature is MVP-deferred; §15 sequences delivery but the contract covers all of it.

### 1.2 Threat model (unchanged at full scope; review-driven)
Deployment is **single-user, local, trusted code**. The defended threat is **"the model fools the user about correctness/completion"** — forged claims, self-authored evidence, stale evidence. It is **not** a multi-tenant/untrusted-worker sandbox. Recursion and speculation raise a *resource* concern (not a confidentiality one), governed by the caps in §6.4. Replay runs commands the user already runs (§13); the MVP boundary stands even at full scope: **no network/FS sandbox of replay** — that is the one upgrade required before any untrusted-worker deployment, surfaced in doctor output as a release-blocking assumption, never silent.

---

## 2. Filesystem layout & trust roots (fixes #1, #3)

```
.claude-hooks/
  policy.yaml                     MODEL-VISIBLE, user-pinned via baseline (§2.1, §5.3)
  probes.ts                       MODEL-VISIBLE, user-pinned via baseline
  briefs/<label>.json             MODEL-AUTHORABLE — untrusted input
  baseline.json                   HOOK-ONLY 0600 — session-start trust snapshot
  session-secret                  HOOK-ONLY 0600 — per-session HMAC key
  runs/
    state/<session>/<run_id>.json HOOK-ONLY — worker-run state (§3.1); run_id is a path of agent ids (§6.2)
    verdicts/<session>/<run_id>.json HOOK-ONLY — signed verdicts (§5.4)
  evidence/<session>/<isc>.json   HOOK-ONLY — evidence graph (§4)
  confirmations/<session>/<isc>.json HOOK-ONLY — signed user confirmations (§11)
  eventstore/*.jsonl              HOOK-ONLY — ledgers (§5.5)
~/.claude-hooks/conformance.json  HOOK-ONLY — machine host facts
```
Enforced + tested: realpath-confinement under `.claude-hooks/`; `O_NOFOLLOW` on every hook-only open; ids match `^[a-z0-9][a-z0-9_-]{0,63}$` (run_id segments joined by `/`, each segment validated); hook-only files mode `0600`, refused if group/other-writable. `briefs/` is the **only** model-authorable dir — the constitution's R2 corollary is corrected: `runs/`, `evidence/`, `confirmations/` are hook-only (resolves review P0-5).

### 2.1 Session-start trust baseline (fix #1 — closes review P0-1)
At `SessionStart`, before any model action, write hook-only `baseline.json`: `{session_id, created_at, git_head, git_clean, trusted_files:{<path>:{sha256,committed}}}` capturing `policy.yaml`, `probes.ts`, and every file a pin references, as they exist *before the session*. **`user_pinned ≡ present in baseline with committed:true`** — an artifact the model could not have authored this session. A mid-session model edit to `policy.yaml`/`probes.ts` (hash ≠ baseline) is untrusted until the next session or a §11 user confirmation; **authority never escalates within a session from model-reachable edits.**

---

## 3. State machines

### 3.1 Worker run (hook-only, `runs/state/`)
```
 SubagentStart ▶ RUNNING ▶ contract ▶ drift ▶ replay ▶ TERMINAL{accepted_verified | accepted_sampled
                  │          (fail at any stage → terminal below)        | audit_required | rejected
                  ▼                                                      | soft_failed | well_formed}
            brief CONTENT snapshot;
            node ancestry + authority recorded (§6)
```
```json
{ "schema_version":1, "session_id":"…", "run_id":"root/impl-a/impl-a1",
  "agent_id":"impl-a1", "parent_run_id":"root/impl-a", "agent_type":"scout|implementer|skeptic",
  "depth":2, "ancestry_labels":["root","cart-fix","cart-fix-sub"],
  "authority":{"tools":["Read","Grep","Glob","Edit","Write","Bash"],"may_spawn":true},
  "state":"RUNNING|TERMINAL", "brief_snapshot":{…}, "warm":false,
  "blocks_used":0, "terminal_outcome":null, "last_event_seq":0, "panel_id":"… | null" }
```
**Idempotency (fix #4):** `terminal_outcome` is single-assignment via compare-and-swap under the file lock, keyed on `(run_id, event_seq)`. Duplicate/replayed `SubagentStop` finds it set → no-op (re-emits prior decision, no second ledger row, no second flip). `SubagentStop` with no `RUNNING` → `soft_failed`, never replay-from-disk.

### 3.2 ISC evidence (hook-only, `evidence/`)
```
 UNVERIFIED ─flip on accepted_verified (full replay)─▶ VERIFIED(graph) ─scope file changed─▶ STALE
     ▲                                                                                        │
     └────────────── re-verify (next accepted_verified) ◀──── manual+confirmed (§11) ─────────┘
```
Only `VERIFIED` with a currently-valid graph (§4) satisfies the evidential gate. `accepted_sampled` does **not** flip (it didn't replay this run); `manual` flips only with a §11 confirmation. Transitions go through the checkpoint **service** (constitution §6.4), emitting the flip-source ledger row.

---

## 4. Evidence graph (fix #2 — closes review P0-4)
On a spine flip, record what it depended on so later change invalidates it. `evidence/<session>/<isc>.json`:
```json
{ "schema_version":1, "isc_id":"ISC3", "isa_path":"…", "flipped_at":"…",
  "flip_source":"replay|manual", "user_pinned":true, "trust_label":"verified|sampled",
  "depends_on":{ "argv":["bun","test","test/cart"], "argv_pin":"policy-allowlist|brief-snapshot",
    "env_hash":"sha256", "cwd":".", "file_scope":{"src/cart/total.ts":"sha256",…}, "git_head":"sha" },
  "status":"valid|stale", "confirmation":"…sig… | null" }
```
`file_scope` = union(brief.files_in_scope, result.changed_files) hashed at flip time. Invalidation runs at `Stop` and at `phase: complete`: recompute `file_scope`; any mismatch → `stale`, ISC → `STALE`, evidential gate blocks, report shows stale (never current). Re-verify = a fresh `accepted_verified` replay. The mechanism neither prior review caught: "verified" means *against bytes that still exist*.

---

## 5. Schemas

### 5.1 WorkerBrief (`briefs/<label>.json`; model-authorable; content-snapshotted at SubagentStart)
```json
{ "schema_version":1, "role":"scout|implementer|skeptic", "label":"kebab",
  "parent_run_id":"… | null", "isa_path":"… | null", "isc_id":"… | null",
  "files_in_scope":["rel/paths"], "lens":"correctness|security|edge-cases|repro | null",
  "warm":false, "strategy":{"mode":"single|speculative","k":1},
  "acceptance":{"argv":["…"],"cwd":".","replay":"required|advisory|none","idempotent":true},
  "allowed_reproduction":[{"argv":["…"],"cwd":"."}] }
```
Validation (`additionalProperties:false`): spine briefs (`isc_id≠null`) require `replay:"required"`, `idempotent:true`, `role≠scout`; `warm:true` requires `role:implementer` and worktree isolation; `strategy.k>1` requires `mode:"speculative"` and `role:implementer`; `lens` only for skeptic. The **snapshot** is canonical JSON; replay/flip read only it.

### 5.2 Results — shapes in `schema/`, rules in pure `policies/`
`ImplementerResult{label,status:done|blocked,summary,workspace{root,base_ref,isolation},changed_files,verification{argv,cwd,exit_code,output_tail}|null,blockers}` (done ⇒ empty blockers, verification present, exit 0). `ScoutResult` (coverage-honesty; finalizes `well_formed`; never spine). `SkepticResult{label,claim,verdict:confirmed|refuted|inconclusive,workspace{root},evidence,reproduction{argv,cwd,expected_exit_code}|null,caveats}` (confirmed requires caveats; refuted requires evidence-or-repro).

### 5.3 PolicyConfig (`policy.yaml`; user-pinned via §2.1) — security-critical
```yaml
schema_version: 1
replay: { timeout_ms: 30000, env_allow: [], allowed_argv: [ {argv:["bun","test"], cwd_policy:"workspace", idempotent:true, max_output_bytes:1048576, risk:"low"} ] }
drift:  { ignore: [".pytest_cache/**","coverage/**"] }
recursion: { max_depth: 2, max_children_per_node: 8, max_concurrent: 8, session_wallclock_ms: 1800000, session_token_budget: 2000000 }
sampling: { enabled: true, min_runs: 50, min_acceptance: 0.95, sample_rate: 0.2, never_sample_risk: ["high"] }
panels:   { default_lenses: ["correctness","security","edge-cases"], majority: 2 }
speculative: { max_k: 4, budget_token_cap: 1500000 }
```
A spine flip's argv must match an `allowed_argv` entry with `idempotent:true`. Trusted only when `policy.yaml` hash matches `baseline.json`.

### 5.4 Verdict (`runs/verdicts/…`; hook-only, HMAC-signed) — `{…,outcome,trust_label,sig}`; orchestrator verifies `sig` (workers never see `session-secret`). 5.5 **Ledgers:** `worker-acceptance`, `isc-flip{channel,user_pinned,trust_label,evidence_status}`, `scaffold`, `delegation{parent,child,depth}`, `panel{members,verdicts,majority}`, `crash-audit`. Append-only, locked, 32KB cap, rotation, redaction-at-boundary.

---

## 6. Recursive delegation (resolves review P1-6)

### 6.1 Authority matrix — capabilities narrow with depth, never widen
A node's authority = `role_capabilities(child) ∩ parent.authority`. A child's tool set must be a **subset** of its parent's; a request to spawn a child with a capability the parent lacks is **denied** (PreToolUse deny on the Agent call). Therefore: orchestrator (full) → may spawn any role; implementer (Read/Write/Bash) → may spawn implementer/scout/skeptic; scout (read-only) → may spawn only scouts; skeptic → leaf (spawns nothing; verification must stay undelegated to preserve independence). `may_spawn` is computed at SubagentStart and frozen in run state.

### 6.2 Identity & topology
`run_id` = parent_run_id + "/" + agent_id; root = the session orchestrator (no parent). Spine flips propagate upward **only** when the *parent's own* brief finalizes `accepted_verified` — never auto-confirm up the tree. A parent cannot finalize `accepted_verified` while a spine-linked child is unresolved.

### 6.3 Cycle prevention
Each node carries `ancestry_labels`; a child whose brief label appears in its ancestry is rejected (blocks A→B→A). Enforced at SubagentStart from the snapshotted brief's `parent_run_id` chain.

### 6.4 Resource governance (the recursion-explosion edge case)
Caps from `policy.recursion`, enforced at the spawn (PreToolUse on Agent): `max_depth` (deny beyond), `max_children_per_node`, `max_concurrent` workers per session (queue beyond — the host owns scheduling, the hook denies over-cap spawns), `session_wallclock_ms`, `session_token_budget` (deny new spawns past budget). Every denial writes a `delegation` ledger row with the reason. Speculative fan-out (§10) counts against these caps.

### 6.5 Failure propagation
A child `rejected`/`soft_failed` does **not** auto-fail the parent — the parent is the orchestrator of its subtree and decides from the child's signed verdict. But the parent's spine ISC cannot flip while a spine-linked child is non-`accepted_verified`.

## 7. Skeptic panels (first-class)
A panel is N skeptic nodes spawned with the same `claim`, distinct `lens` (default `policy.panels.default_lenses`), each ephemeral (§9), each drift-checked and (if its `reproduction` is a command) replay-verified. The seam treats each as an ordinary skeptic run; the **panel verdict** is computed by a pure policy: `refuted` if ≥`policy.panels.majority` members refute; else `confirmed` only if all non-inconclusive members confirm; else `inconclusive`. A `panel{members,verdicts,majority}` ledger row records the spread; a dissent inside a majority is surfaced in the report, never silently dropped. Panels never flip spine ISCs directly — they gate the orchestrator's decision to *accept a claim*, which is judgment, not a world-fact.

## 8. Intensity sampling (resolves Q11 + review P1-8)
Verification load scales with measured reliability, with **distinct trust labels so sampled ≠ verified**:
- `accepted_verified` — full replay ran and matched this run.
- `accepted_sampled` — replay skipped under sampling; **never flips a spine ISC**, rendered distinctly in the report, and carries an `audit_due` marker.
- `audit_required` — a periodic full re-check (every `1/sample_rate` sampled runs per role) that must run before further sampling of that role.

Eligibility (`policy.sampling`): a `(role, brief-shape)` may be sampled only at `runs ≥ min_runs` (50) **and** `acceptance ≥ min_acceptance` (0.95); `sample_rate` 0.2 (verify 1 in 5). **Never sampled:** spine-linked runs, `risk:"high"` argv, panel members. **Any contradiction resets the role to every-run** and clears its sampling eligibility. Sampling is the only place trust accrues over time; it can only *reduce* replay frequency for proven-safe shapes, never for the spine.

## 9. Warm execution (resolves Q13)
An implementer may be **warm** (`brief.warm:true`, worktree isolation) — reused across legs of the **same ISA**, retaining context and its worktree, to keep convention/consistency. Constraints: warm is implementer-only; **scouts and skeptics are always ephemeral** (fresh-context independence is a verifier's whole value — warming them is forbidden by schema validation); a warm worker still faces **full replay + drift per leg** (warming never dilutes verification); a warm worker's authority is fixed at first spawn and cannot widen across legs.

## 10. Speculative parallelism (resolves Q12 — with the world-fact selector it was waiting on)
For an explicitly path-uncertain brief (`strategy.mode:"speculative", k:N≤policy.speculative.max_k`): spawn K implementers, each in its own worktree, same brief, different `agent_id`. **Selector is a world-fact, not a judgment:** the winner is the approach whose pinned acceptance replay passes (`exit 0`); ties broken by fewest `changed_files`, then earliest finish. Losers' worktrees are discarded; their runs ledger as `rejected` (selector) or `soft_failed` (no pass). If none pass → all `soft_failed`, orchestrator decides. K counts against §6.4 caps and `policy.speculative.budget_token_cap`. Only implementers speculate (scouts/skeptics have no pinned world-fact selector).

## 11. Manual confirmation channel (resolves review P1-9)
A `manual` ISC flip, or trusting a model-edited probe/policy mid-session, requires a confirmation the **model cannot forge**: the hook raises a host **Elicitation** (R6-probed) asking the user to confirm; the user's **host-delivered** response (not worker text) is captured and written HMAC-signed to `confirmations/<session>/<isc>.json`. The evidential gate accepts a `manual` flip only with a valid, current confirmation whose `depends_on` hashes still match (§4). If the host doesn't support elicitation (conformance false) → manual flips **never** satisfy the gate (fail closed). No CLI-typed secret, no file the model can write — the trust root is the host's user channel.

## 12. Event contracts (full 29)
| Event | Consumes | Emits / Action | Failure |
| --- | --- | --- | --- |
| SessionStart | cwd, git | write baseline + session-secret; brief inject | no-op + crash-audit |
| UserPromptSubmit | prompt | regex workflow tag + regen heads-up (no nudge-to-invoke) | no-op |
| UserPromptExpansion | expanded prompt | blast-radius warning | no-op |
| PreToolUse | tool_name, tool_input | safety → capability → **spawn-authority/caps (§6)** → engagement(if ISA) → TDD(opt-in) | **malformed→ask; gate crash→ask (fix #5)** |
| PostToolUse | tool_response | verification watermark; ISA-edit bookkeeping | no-op |
| PostToolUse(`Agent\|Task`) | tool_response | signed-verdict injection (host-id correlation, R6) | no-op |
| PostToolBatch | batch | retired → NoOp | no-op |
| PostToolUseFailure | error | failure-explainer | no-op |
| PermissionRequest / Denied | pattern | autopilot replay / denial ledger | no-op |
| Stop | state | evidence invalidation (§4) → evidential gate(if ISA) → verify-map on changed files; budgeted | no-op |
| StopFailure | error | categorize | no-op |
| SubagentStart | agent ids, type | snapshot brief content; compute authority/ancestry (§6); panel/spec/warm tagging | no-op (Stop soft_fails) |
| SubagentStop | ids, last msg | contract→drift→replay→selector(if spec)→verdict→ledger→flip; **CAS terminal** | no-op; missing-Start→soft_failed |
| PreCompact / PostCompact | — | snapshot ISA + active runs / rehydrate | no-op |
| SessionEnd | — | session ledger + ISA archive | no-op |
| CwdChanged | cwd | frozen session_root discipline | no-op |
| WorktreeCreate | base, name | `git worktree add`; raw path stdout | **failure→empty stdout+nonzero exit+stderr** |
| WorktreeRemove | path | archive ledgers; cleanup | no-op |
| ConfigChange / FileChanged | path | config-guard / env-guard; **re-hash vs baseline (§2.1)** | no-op |
| InstructionsLoaded / Notification / Setup / TeammateIdle | — | staleness / log / init+gc / advisory | no-op |
| Elicitation / ElicitationResult | request/response | **manual-confirmation capture (§11)** + cache | no-op |
| TaskCreated / TaskCompleted | — | task-integrity: advisory outside ISA; blocking(evidential) with ISA | no-op |

## 13. Replay execution contract
Pinned argv only; raw `spawn(argv0,argv[1:],{detached:true})` (own pgroup); env **replace** with `{PATH,HOME,LANG,TMPDIR}+policy.env_allow`; cwd canonicalized + confined to `workspace.root`; `timeout_ms` then `kill(-pgid)`; output capped at `max_output_bytes` + redacted; exit compared to claim. §1.2 boundary: no network/FS sandbox (single-user-local); surfaced in doctor as the upgrade condition for untrusted-worker use.

## 14. Failure taxonomy (fix #5)
Security gates (destructive/secret/protected/settings/capability/**spawn-authority**) → **fail closed → `ask`** + crash-audit. Availability (inject/ledger/verdict/drift-infra/replay-infra) → fail open (no-op; evidence not established → run cannot be accepted). Unknown drift (git infra) → `soft_failed`, never accepted. WorktreeCreate → explicit error. Every crash → `crash-audit` row. R4 "fail open" is scoped to the availability class (R8 change; reviewers: build-readiness review + author).

## 15. Rollout (full)
P0 doctor+decode+logs · P1 input gates · P2 contracts+signed verdicts · P3 trusted replay + evidence graph (flips off) · P4 flips on valid evidence · P5 verdict injection · P6 recursion + authority/caps · P7 panels · P8 warm + speculative · P9 intensity sampling. Each gated on the prior proving out; each independently revertible by flag.

## 16. Honest externalities (not deferred features — genuine unknowns)
- Per-host payload schemas for events the doctor can't yet probe at a given Claude Code version (R6 covers detection; field names track the host).
- Nested-subagent host support (does the host fire SubagentStart/Stop at depth with stable ids?) — a **new conformance probe** gates recursion (§6); if false, recursion degrades to depth-0 only and the doctor says so.
- Performance budgets (p50/p95) beyond per-event timeouts — set from P0 telemetry.
- **POSIX-only** (`O_NOFOLLOW`, detached pgroups, `kill(-pgid)`); installer refuses win32.

## 17. Acceptance tests (executable; full scope; deny-by-default)
MVP rows (from the prior cut, all retained): malformed PreToolUse→ask · safety crash→closed/ask · scout Write→deny · label `/`/`..`→reject · brief symlink→reject · brief modified post-Start→snapshot used · worker argv≠pin→no spine flip · policy edited mid-session→authority not trusted · probe committed mid-session→not user-pinned · env secrets→absent unless allowlisted · `$(whoami)`→literal · replay fork past timeout→pgroup killed, not accepted · drift infra fail→soft_failed · duplicate SubagentStop→one terminal/one flip (CAS) · missing Start→soft_failed · scope file changed post-flip→stale, phase:complete blocks · scout linked to spine→reject · WorktreeCreate NoOp→empty stdout · WorktreeCreate fail→nonzero+stderr · bad-HMAC verdict→untrusted.
**Full-scope rows:** scout spawns implementer→deny (capability widen) · spawn past max_depth→deny · spawn past max_concurrent→deny/queue · cyclic brief label→reject · child rejected→parent may still finalize but spine-child-unresolved→parent spine flip blocked · panel 2-of-3 refute→panel `refuted` · warm skeptic brief→schema reject · warm implementer leg 2→still full replay · speculative K=3, one passes→that one wins, 2 worktrees discarded · speculative none pass→all soft_failed · sampled run→`accepted_sampled`, no spine flip, audit_due set · sampling after a contradiction→role reset to every-run · manual flip without elicitation support→never satisfies gate · manual flip with host confirmation→satisfies, recorded signed · session over token_budget→new spawns denied.
