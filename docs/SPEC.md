# claude-hooks-ts — Final Specification

**Version:** 2.0 (restructured around the recursive node; pending re-run of the adversarial panel + user review)
**Date:** 2026-06-12
**Status:** End-state constitution. `docs/MIGRATION-PLAN.md` v0.2 owns sequencing; this document owns identity, doctrine, and architecture.
**Lineage:** first-principles audit (2026-06-11, measured classifier telemetry) → claude-workers v1.0 (built, 88 tests, live-verified seam) → joint review: Algorithm retained → subsystem scout pass over this repo's Effect machinery → five-lens adversarial panel (30 findings, §16) → **joint review 2026-06-12b: the Algorithm is not a mode, it is two auto-scaled axes per node; the five-plane org chart is replaced by the node skeleton (this document).**

**Reading order:** §2 (doctrine) and §3 (the shape) carry the architecture; §16 records what the adversarial panel broke in the v1.x drafts and how it was fixed. Decisions the spec does **not** presume settled are flagged `[OPEN: Qn]` inline and collected in §15.

---

## 1. Identity

claude-hooks-ts is a **deterministic runtime that makes Claude Code's work verifiable at its boundaries**, and a **methodology that scaffolds hard problems** — both delivered through one shape applied recursively. One Bun binary handles all 29 hook events through typed schemas, routes via exhaustive matching, emits one decision per event.

What it is *not*, by constitution: a cognition manager. No component decides, for the model or the user, how much ceremony a task deserves and then *imposes* it. Help scales itself; enforcement keys off facts. Neither is invoked.

### 1.1 Threat model & honest guarantees (revised 2026-06-13 after the F1–F9 / N1–N9 adversarial round)

The hooks run as the **same OS user as the model** on a local single-user machine. That substrate bounds what any gate can promise, and an empirical adversarial review (PR #92) falsified the stronger framing used elsewhere in this document ("the model cannot make its own claim count as trusted"; "dual & unforgeable verdict", §6.5). The honest statement:

- **Defended:** a model **over-claiming by self-certification** — calling work done/verified without producing the evidence a gate requires. Completion demands an evidence artifact of a specific shape, in a write-protected directory, surviving a staleness recheck (§6.4); replay executes only allowlist/brief-pinned argv (§6.3); capability and safety gates are deterministic. This raises the cost of **careless or confused** over-claiming — the common failure mode.
- **NOT defended:** a **deliberately adversarial** model with shell access. Because it runs as the user it can read any on-disk secret (HMAC artifacts are therefore forgeable — N4) and write any protected file via an interpreter the path-gate cannot parse (N2/N3). In a same-user model **there is no on-disk trust root the model cannot reach.** The gates are **defense-in-depth and an honesty scaffold, not a cryptographic guarantee** against forgery.
- **Consequence:** the "unforgeable" language in §6.5 and the "teeth" of §6.4 hold against accidental over-claiming, **not** against forgery. A forgery-proof root would require a secret outside the model's read-reach (unavailable on this substrate) or an external trust party (a remote / second user). Until then, every "cannot forge" claim here is scoped to the non-adversarial case.

Full boundary and the residual-finding ledger: **`docs/THREAT-MODEL.md`**.

## 2. Doctrine

Eight invariants. Every PR is judged against them; **R8 judges the judges.**

- **R1 — No LLM in the hook path.** No handler spawns a model subprocess. Judgment lives in the main model and the user; hooks are deterministic. (Basis: measured p50 5.5s/prompt classifier tax; fail-safe-to-max-ceremony.)
- **R2 — Hooks never mutate project source mid-session.** Writes are confined to `.claude-hooks/` state; ISC flips happen at gate-evaluation points (Stop, SubagentStop), never mid-edit. **Corollary:** hook-writable ≠ hook-trusted — files the model or a worker can author (`probes.ts`, `briefs/`, `runs/`) are untrusted input and get the same provenance discipline as replay argv (§6).
- **R3 — Blocks cite named, checkable world-facts; help never blocks.** A block must cite one of a closed set: (a) a replayed command's exit code; (b) a dirty workspace (git porcelain residue); (c) a tool capability violation; (d) a field of a *registered worker-result schema*; (e) in the presence of a declared ISA, the absence of non-author evidence for a declared criterion (or zero declared criteria at `phase: complete`). Section counts and heading shapes only warn. The enumeration is exhaustive by design — a check that fits none of (a)–(e) is help, not a gate.
- **R4 — Fail open, bounded, never trapping.** Block budget ≤ 2 per worker run, all checks combined; every failure path releases with evidence; a hook crash is a no-op (`SAFE_DEFAULT`), with exactly two exceptions: `PreToolUse` malformed-input fails closed to `ask`, and `WorktreeCreate` handler failure surfaces an explicit error (empty stdout + nonzero exit, §4) rather than `{}`-as-path.
- **R5 — Help self-scales; enforcement keys off world-facts; nothing is invoked.** Scaffolding depth is assessed by the working model from in-progress signal (never a prompt-time classifier — true difficulty isn't visible until the work is underway) and applied passively as part of doing the work: the model writes its ISA at the depth it judges. **There is no invoke step and nothing prompts one.** `/algorithm [tier]` survives only as a rare manual **override** for when the user wants to pin a heavier or lighter depth than the model chose; it is never required and never the path. Blocking fires on artifacts produced — files changed → verify; an ISA present → its declared criteria bind — never on a declared "mode." `engagement_source` (`self` | `user_override` | null) is ledgered provenance, not a switch. No classifier, no nudge-to-invoke, no consent ceremony.
- **R6 — Probed conformance over assumed host behavior.** Load-bearing host facts — block-feedback, verdict injection, payload fields, worktree isolation, and the source of the agent-id used for verdict correlation — are probed per machine+version; behavior is keyed to `conformance.json` with defined degraded modes. A host upgrade degrades the system; it never breaks it.
- **R7 — Measured from day one.** Every worker run, every ISC flip, every ISA depth-setting produces ledger rows (§8). Trust thresholds drive *content* iteration (prompts, templates, the self-scaffolding skill prompt), never new gates.
- **R8 — Anti-ratchet, with a rejector.** Any proposed gate checking an artifact's shape rather than an R3-enumerated world-fact is rejected by default; any proposal adding an LLM call to a hook is rejected by default. **Enforceability: an amendment touching any gate requires a named reviewer who is not the proposal's author — the adversarial-panel pattern this document was hardened by — recorded in the decision log.** Tracked metric is gate-count and block-event-rate, not just src line-count. The 66k-line history is the cautionary tale.

## 3. The shape: one recursive node, two axes

The system is not five planes. It is a **substrate**, a **node** that recurses, two **axes** that scale per node, and a **memory** that lets them scale and proves they earn their keep.

```
                         ┌───────────── MEMORY & MEASUREMENT (§8) ──────────────┐
                         │  ledgers · conformance · report · eval · kill crit.  │
                         └───────────────────────▲──────────────────────────────┘
                                                  │ feeds intensity & proves value
   ┌──────────────────────────── THE NODE (§5) ───┴───────────────────────────┐
   │  orchestrator ≡ worker at depth d.  Owns a plan (its ISA slice).          │
   │  May self-scaffold and self-delegate (bounded recursion).                 │
   │                                                                           │
   │   HELP AXIS (§7) ─ self-scaled, NEVER blocks      VERIFY AXIS (§6) ─ world-fact, ALWAYS-ON │
   │   scaffolding depth · context briefs (self-scaled) input-safety · capability · replay ·     │
   │   (more help when the work looks hard;            drift · evidential-ISC — scaled by       │
   │    wrong guess wastes tokens, never traps)        intensity; fire on artifacts produced    │
   └───────────────────────────────▲───────────────────────────────────────────┘
                                    │ runs on
                  ┌─────────────────┴──────────────────┐
                  │        SUBSTRATE (§4)               │
                  │  dispatch · schema · layers ·       │
                  │  session-state · persistence (Effect)│
                  └──────────────────────────────────────┘
```

The two axes are orthogonal and both scale to the problem automatically: **help** because the working model has the signal to judge how much it needs (and mis-judging is cheap), **verify** because it keys off facts that need no judgment at all. Fusing them — the v1.x error — was what forced a human consent ceremony; splitting them is what makes passive right-scaling safe. Crucially, **both axes apply at every node**, so the methodology is a fractal, not an orchestrator-global mode.

## 4. Substrate — the Effect runtime (retained verbatim; it earned it)

- **Dispatch:** `dispatcher.ts::program` (stdin → `decodeRawPayload` → `normalizeHookEvent` → `withSession` → `routeByTag` via `Match.tagsExhaustive` → per-event timeout `handlerTimeoutFor` → `emit`). New handlers = payload schema + handler + one Match arm; the compiler enforces exhaustiveness. Timeouts: default 4s, Stop 28s, **UserPromptSubmit dropped 30s→4s** (the 30s was `25s classifier + headroom`, dead once the handler is regex-only), **SubagentStop = `replayTimeoutMs` + 15s**.
- **Decisions:** the 7-variant `HookDecision` union (`decisions.ts:77`) covers every need *except* WorktreeCreate error. WorktreeCreate emits a *raw path* on stdout, so (a) `emit`/`encodeDecisionForStdout` must thread the event tag so a WorktreeCreate `NoOp` emits **nothing**, not `{}`-as-path; (b) handler failure surfaces an explicit error wire-encoding (empty stdout + nonzero exit + stderr), confirmed against the host by a §8 doctor probe. Second R4 crash exception.
- **Layers:** `makeAppLive` stands; the legacy worker runtime layer (`Queue/Runs/Aggregation/Integration/Supervisor/Executor`, `services/worker-integration.ts`) is replaced by the verify-axis services (§6); `InferenceLive` **and `services/claude-subprocess.ts`** are removed (R1 makes the model-subprocess spawner dead weight — the M4 grep audit must search `claude-subprocess|ClaudeSubprocess`, since neither contains "inference"/"classifier"). `AppTest` substitution idiom retained.
- **Session state:** three-slice `SessionStateRecord` retained — `EngagementState` (gains `engagement_source: "self"|"user_override"|null`, default `null` ⇒ no ISA yet; classifier fields removed; in-flight classifier-era sessions get `null` on upgrade, gates deactivate, intended), `VerificationLedger` (watermark unchanged: re-verify on `files_changed \ verification_files`; the `probe_verified_iscs` element-type change is the one migration, §6.5), `ModeCache` (classifier fields dropped; workflow tag stays regex-derived). FileLock discipline and FiberRef session context unchanged.
- **Persistence:** EventStore JSONL streams with redaction-at-boundary, 32KB line caps, `compact()` rotation — the §8 ledgers are new streams, not new mechanisms.

## 5. The node — orchestrator ≡ worker, recursive

A node owns a slice of plan (its ISA, or sub-ISA) and produces artifacts. The orchestrator is the depth-0 node; a worker is a depth-d node with a bounded brief. They are the **same shape**: both may self-scaffold (§7) and, when a leg turns out to be a hard multi-part problem, **self-delegate** — write a sub-ISA and spawn sub-workers — with the verify axis (§6) binding every node identically.

- **Recursion bounds:** depth cap `maxDelegationDepth` (default 2); the economics rule applies at each level (delegate only small-interface/large-interior legs); every sub-worker's claims face the same replay/drift gates, so depth never dilutes verification. Decomposition is *discovered by working*, which is why leaf-only workers (the v1.x model) wrongly forced premature top-down planning.
- **The ISA is the node's plan and a shared blackboard.** `## Criteria` (ISCs) and `## Features` are the decomposition; workers flip ISCs through the spine (§6.4). Naming it a blackboard makes the coordination deliberate rather than accidental — workers contribute to one evolving structure rather than a star of disconnected briefs.
- **Roles** (the leaf node-types the installer ships, with the `delegation` skill): `scout` (Read/Grep/Glob — capability is the enforcement), `implementer` (Edit/Write/Bash, `permissionMode: acceptEdits`, worktree), `skeptic` (Bash refuter, worktree, drift-checked). No worker-mandatory mode (mandates breed adversarial compliance). No `memory:` on verifier roles ever — **fresh-context independence is a skeptic's whole value** (§7 permits implementers to warm within one ISA's legs `[OPEN: Q13]`; skeptics never). **Skeptic panels are first-class** (promoted from a skill hint): for high-stakes claims, N skeptics with distinct lenses (correctness / security / repro), majority verdict — this session's own 5-lens panel found two critical flaws a single check would have missed.

## 6. The verification lattice — world-fact enforcement (always-on, intensity-scaled)

The v1.x "Safety plane" and "Worker seam" were the same family seen at two points: **deterministic checks of facts about the world.** Unified here. Every gate keys off an *artifact produced*, never a declared mode; all are R3-enumerated; all bounded by R4.

**Layer map (respect `ARCHITECTURE.md`):** result *shapes* in `schema/`; decision *rules* (safety matchers, contract discriminants, coverage/caveat rules, brief-trust comparison, drift filtering, outcome derivation) as **pure functions in `policies/`**; effects (spawn, replay subprocess, `git status`, verdict IO, EventStore) in `services/`; handlers as thin orchestration.

### 6.1 Input gates (on tool calls) — retained, enumerated, frozen
`destructive-commands`, `secret-paths` (read+write), `protected-paths`, `settings-self-protection`, `generated-files`, `lockfile-paths`, `permission-patterns`, `content-scan` (report-only), inspection whitelist; `reducePolicies` priority (deny > ask > allow > passthrough); fail-closed-to-`ask` on malformed `PreToolUse`. Capability profiles on worker roles are input gates too (a scout *cannot* write). **Canonical PreToolUse order:** Plane-I safety → engagement (if an ISA is present) → TDD (opt-in) → worker gates — safety first, so `isaPretoolGateDisabled` never bypasses safety. This plane is also the prerequisite for Bash-capable roles; the installer refuses them without it.

### 6.2 Output gates (on worker results) — the transplanted seam
Live-verified (2026-06-12): brief `registered` → 2 contract blocks → self-correction → replay `match` → `accepted` → verdict injected.
- **Contracts:** `Scout/Implementer/SkepticResult` shapes as Effect `Schema`; rules (`done|blocked` discriminant, scout coverage-honesty, skeptic `confirmed`-requires-caveats) as pure `policies/` functions. Failure → block with field-naming reason (worker self-corrects; H4 probed TRUE) within budget; then `soft_failed`, raw text released.
- **Drift (skeptic):** `git status --porcelain=v1 -z` minus configured ignores and the snapshotted brief's `patch_manifest`; residue blocks once then rejects; never blocks on git infra failure.
- **Outcomes:** `accepted` / `rejected` (world-fact stood against the claim) / `soft_failed` (released, trust not established) / **`well_formed`** (scout — schema-valid is not truth, and the name says so on *every* channel: verdict file, injected verdict, ledger).

### 6.3 Safe replay (security-critical; any change is an R8 event)
Allowlist- or snapshotted-brief argv — *never* worker-chosen; argv-only (no shell mode exists). Two named `CommandRunner` extensions, both regression-tested as security properties:
- **Env allowlist (replace, not merge):** replay env is *replaced* with `PATH/HOME/LANG/TMPDIR + replayEnvAllow`, not the current `{...currentProcessEnv(), ...}` merge. The repo's only scrubber is a 3-key *denylist* (`scrubClaudeEnv`); replay needs the inverse, or a pinned `npm test` inherits `AWS_*`/`GITHUB_TOKEN` and replay runs *outside* Plane I.
- **Process-group kill via a raw detached-spawn path:** `@effect/platform Command` exposes no `detached`/`setpgid`, so the draft's `kill(-pid)` no-ops or kills the hook. Replay uses a dedicated raw `spawn(..., {detached:true})` (setsid), captures the pgid, teardown signals `kill(-pgid)`. Bounded honestly: does not reach descendants that themselves `setsid()`/daemonize — partial containment, stated.
- canonicalized workspace, cwd-inside-root; bounded redacted tails; `replay:"none"` honored absolutely (non-idempotent never re-run; caps at `soft_failed`). The pin + env-allowlist + group-kill discipline *is* replay's safety model (it runs outside Claude Code's permissions), plus Plane I for what the worker itself does.

### 6.4 The evidential ISC gate + the spine
An ISA reaching `phase: complete` is blocked if `## Criteria` has **zero ISCs** (closes the empty-stub bypass at `lifecycle.ts:469`) or if any ISC lacks a **non-author** evidence channel; a `manual` flip never satisfies it without **user** confirmation. Structural checks warn only (R3). This binds whenever an ISA exists — no invocation needed; to *escape* it you must decline to declare criteria at all, itself a ledgered, visible choice (§8 scaffold ledger), not a silent bypass.

**The spine:** a `## Criteria`/`## Features` entry may declare `brief: <label>`; the brief carries `{isa_path, isc_id}`; a worker run finalizing `accepted` **with allowlist-pinned replay (§6.5)** flips the linked ISC through a checkpoint operation **moved behind a service** (the current `algorithm/isa/checkpoint` is raw-`fs` + direct `runCommandLive`, untestable and unable to emit the §8 ledger row — it must take `FileSystem`/`Git` from context). **Scout briefs are barred from spine linkage** (a schema-valid scout report has no replayable world-fact). With recursion (§5), a sub-worker's flip propagates upward only when the *parent's* brief finalizes accepted — depth never auto-confirms upward. `rejected`/`soft_failed` never flip. **Plan in the ISA, execute through workers, verify by allowlist-pinned replay.**

### 6.5 Provenance ranking, intensity scaling, trust, migration
- **Provenance is the whole game (panel GOODHART-2):** every evidence channel was authored by the agent the gate distrusts, so "does manual trend to zero?" is gamed by theater migrating into `probe`/`replay` labels. Rank by *who authored the evidence*:

| Tier | Channel | Counts above `manual` only if… |
| --- | --- | --- |
| Trusted | user-pinned probe | `probes.ts` is git-committed (clean) OR sha256-snapshotted when the ISA is created, AND unmodified during any worker run. Run in a **sandboxed subprocess with the replay env allowlist** — never in-process `await import()` (panel SEC-1: that is unsandboxed RCE with full hook env). |
| Trusted | allowlist-pinned replay | spine argv comes from project `replayAllowedArgv`, NOT an orchestrator-authored brief (a brief pinning `["git","status"]` replays to exit 0 and flips a truth-claim ISC otherwise). |
| Untrusted | brief-pinned replay (non-spine) | fine for ordinary verification; does not flip spine ISCs. |
| Untrusted | manual | model-authored; ledgered; never satisfies the evidential gate without user confirmation. |

- **Brief trust snapshot (TOCTOU-closed):** orchestrator registers `briefs/<label>.json` before spawn; `<label>` strict-charset (no separators); path realpath-confined under `<session_root>/.claude-hooks/briefs/`, opened `O_NOFOLLOW` (reject symlinks/non-regular). `SubagentStart` snapshots the canonicalized brief **content** (argv, isa_path, isc_id) — not just a hash — and replay/flip execute strictly from the snapshotted buffer; the on-disk file is never re-read for argv.
- **Verdict channel, dual & unforgeable:** verdict file written **only by the hook process** to a worker-unwritable dir (`runs/` under the hook-owned state root, realpath-confined, never inside a worktree); in shared-checkout degraded mode, verdicts are **HMAC-signed with a per-session secret** workers never see. `PostToolUse(Agent|Task)` `ContextInjection` when `conformance.verdict_injection: true`; correlation keyed to **host-supplied agent/tool-use metadata (a probed R6 fact), never worker text**; fails closed (injects nothing) on absent/ambiguous id.
- **Intensity scaling (the verify-axis analogue of scaffolding depth):** a role/brief-shape with long high-acceptance history earns *sampled* replay (1-in-N + audit); a role running hot on contradictions gets every-run + a skeptic. Bounded: spine-linked flips are **always** fully verified regardless of reputation, and any contradiction resets the role to every-run. `[OPEN: Q11]` sampling curve (recommend: sample only above n≥50 & ≥95% acceptance; never spine flips).
- **State migration:** `probe_verified_iscs` is session-scoped today (`Schema.Array(Schema.String)`, cross-contaminates ISAs sharing an ISC id) and wired into the string-only append API. Change to `Array<{isa, isc, source, user_pinned}>` requires: bump `SESSION_STATE_SCHEMA_VERSION` to 2; add a real `migrateSessionStateRecord` step (does not exist) running *before* strict decode; remove `probe_verified_iscs` from `AppendableKey`; add a typed flip op with `(isa,isc)` value-equality dedupe; update the `post-edit-quality.ts` writer + `lifecycle.ts` reader.

## 7. The help axis — scaffolding & context (self-scaled, never blocks)

Help scales to assessed difficulty, assessed by whoever has the best signal: **the working model**, not a prompt-time classifier.
- **Scaffolding (ISA depth) — the passive default and the only path:** the model, having begun and seen the real shape of the work, writes its ISA at the depth that fits — a 2-line plan for a rename, a full E5 decomposition for a cross-cutting migration. This is the model self-scaffolding as part of doing the work (`engagement_source: "self"`), not a user action and not a hook that fires. A context emission, not a gate; no `engagement_required`, no tool denial follows. Mis-scaling is cheap and self-correcting (under-scaffold → escalate when the work reveals itself; over-scaffold → some wasted tokens) — the asymmetric, recoverable error profile that *should* be automated rather than gated or invoked. If the model chronically under-scaffolds hard problems, that is a skill-prompt quality issue surfaced by §8's depth-vs-difficulty measurement and fixed by content iteration (R7) — never by a hook that nudges a human to invoke ceremony.
- **Manual override (rare — the entire human role in scaffolding):** `/algorithm [tier]` lets the user pin a depth when they disagree with the model's self-assessment (`engagement_source: "user_override"`). There is deliberately **no nudge prompting the user to invoke the Algorithm** — invocation is not the mechanism, and injecting such a prompt into a compliance-biased model would relaunder the classifier ceremony the reframe removed (panel GOODHART-3). `[OPEN: Q9]` retired: the nudge is removed, not defaulted.
- **Context (ambient help):** `session-start-brief` (2KB), `precompact-snapshot`/`postcompact-ledger` (ISA + active-worker rehydration), `stop-failure`/`failure-explainer`, `cwd-changed` (frozen `session_root`), `config-guard`, `filechanged-env-guard`, `instructions-loaded`, `user-prompt-expansion` blast-radius warning. All injection-only.
- **Tiers** `[OPEN: Q10]` — E3/E4/E5 templates kept as-is for now; whether they simplify to one self-scaling template is post-eval.

## 8. Memory & measurement

- **Acceptance ledger** (`worker-acceptance` stream): one terminal row per run — role, label, brief trust, contract blocks, replay verdict (+exits), drift, outcome (incl. `well_formed`), duration, channel, and for spine runs `(isa_path, isc_id)`.
- **Scaffold ledger:** one row per ISA whose depth was set — self-scaffold depth, the difficulty signal the model saw, `engagement_source` (`self` vs `user_override`), terminal disposition. This measures whether self-scaling *matches difficulty* (the thing that matters), replacing the draft's "invocations/week" — a metric that rewarded invocation and recreated exactly the widen-the-nudge pressure the reframe removed.
- **Flip-source ledger:** every flip records `{channel, user_pinned}`, not a bare label; the standing question reads against `user_pinned`.
- **Report** `claude-hooks-workers report [--since|--json|--unread]`: per-role trust, scout as `well_formed`, `--unread` for non-accepted verdicts never injected, **plus a consumption signal** — when a run finalizes non-accepted, whether later main-session edits touched the worker's declared scope (a world-fact proxy for "integrated anyway"). Recommendations are content-directed and n-gated; the CLI never proposes a gate (R7).
- **Conformance:** `claude-hooks-doctor --probe-host` runs the probes (payload fields, block feedback, verdict injection, worktree isolation, agent-id correlation source), writes machine-scoped `~/.claude-hooks/conformance.json` + project override, re-probes on host version change; synthetic round-trip covers one payload per wired event class (not just SessionStart). Contingency: `block_feedback` false ⇒ no blocks, straight fail-forward; `verdict_injection` false ⇒ file-only + `--unread`; `payload_ok` false ⇒ seam self-disables to an advisory line; `isolation_worktree` not-true ⇒ shared-checkout + disjoint-scope mode.
- **Standing eval (kill criteria pre-committed, 4-week windows):** implementer/skeptic acceptance <70% (n≥10) after one content iteration ⇒ revise/cut the role; **scouts** use skeptic/spot-check contradiction rate or orchestrator-marked usefulness (acceptance≈100% can't fail); seam-wide context-savings <20% AND zero skeptic catches ⇒ retire the seam, keep the prompts. Algorithm metric: self-scaffold-depth vs. problem-difficulty match, plus override frequency (frequent `user_override` ⇒ the model's self-assessment is miscalibrated — a content-iteration signal, not a gate) and the `user_pinned` flip mix.

## 9. Event surface (all 29, post-migration)

| Event | Handler | Axis/Class |
| --- | --- | --- |
| SessionStart | brief + stale-work archival | help (inject) |
| UserPromptSubmit | regex workflow tag + regen heads-up (no nudge-to-invoke) | help (<5ms, R1) |
| UserPromptExpansion | blast-radius warning | help (inject) |
| PreToolUse | safety → engagement(if ISA) → TDD(opt-in) → worker gates | verify (deny/ask) |
| PostToolUse | verification watermark + ISA-edit bookkeeping (no formatter, no mid-edit flips) | substrate (observe) |
| PostToolUse (`Agent\|Task`) | seam verdict injection | help (inject) |
| PostToolBatch | retired → NoOp | — |
| PostToolUseFailure | failure-explainer | help (inject) |
| PermissionRequest / Denied | autopilot replay / denial ledger | verify / observe |
| Stop | `stop-verify`: world-fact gates (verify-map on changed files; evidential ISC if ISA present); unmatched changed files **advisory** | verify, budgeted (26s/28s) |
| StopFailure | error categorization | help (inject) |
| SubagentStart | seam: role filter, state init, brief content-snapshot | substrate (observe, <30ms) |
| SubagentStop | seam: contract → drift → replay → verdict → ledger → ISC flip | verify, budgeted (R4) |
| PreCompact / PostCompact | ISA + worker-run snapshot / rehydrate | help (observe/inject) |
| SessionEnd | session ledger + ISA archive | memory (observe) |
| CwdChanged | frozen-root discipline | substrate |
| WorktreeCreate | `git worktree add` + mirror; **explicit error on failure; NoOp emits nothing** | substrate (raw path) |
| WorktreeRemove | ledger archival + cleanup | memory (observe) |
| ConfigChange / FileChanged | config-guard / env-guard | help (inject) |
| InstructionsLoaded / Notification / Setup / TeammateIdle | staleness / log / init+gc / **advisory only** | help/observe |
| Elicitation / ElicitationResult | cache + replay | substrate (special) |
| TaskCreated / TaskCompleted | `task-integrity`: **advisory outside an ISA; blocking (evidential) when an ISA is present** | verify-if-ISA / observe |

Deleted: prompt-router classification, `inference`, `claude-subprocess`, inflation/deflation guards, `subagent-scope-gate`, worker supervisor/queue/aggregation/integration/executor, `read-tldr`, `test-output-rewrite`, `batch-context-governor`, `context-budget`, post-edit formatter+flip machinery, worker-mandatory.

## 10. Configuration

**RuntimeConfig (env, load-once):** `isaPretoolGateDisabled`, `tddGateEnabled`, `seamEnabled`, `maxDelegationDepth` (2), lock/timeout keys, `replayTimeoutMs` (a *ceiling* feeding the SubagentStop cap). **PolicyConfig (project YAML)** owns the security-critical replay surface — `replayAllowedArgv`, `replayEnvAllow`, `driftIgnore`, and intensity-sampling params — reviewable in-repo (an env-delivered argv allowlist is the wrong carrier for an R8-protected surface). Conformance at `~/.claude-hooks/conformance.json`. All defaults in `docs/CONFIG.md`.

## 11. Testing doctrine

Retained idioms: `Schema.decodeUnknownSync` fixtures; `AppTest`/`SessionStateTest`/`RuntimeConfigTest` substitution; Effect.gen assertions; deliberate malformed-payload paths. Additions: **characterization-first transplants** (port the 88-test intent before the implementation); golden-decision tests for every blocking path; the replay executor's security properties (argv-no-shell, env-replace allowlist, path escape, group-kill, redaction) are permanent regression tests; **recursion tests** (sub-worker spine flips, depth cap, no upward auto-confirm); one live e2e per release (the 2026-06-12 run is the template); doctor probes double as the host-regression suite.

## 12. Change control

Amend only by decision-log entry naming the world-fact a gate checks (R3), the measured evidence (R7), and the **named non-author reviewer's** verdict (R8). Tracked metric: gate-count and block-event-rate (line-count is a gameable proxy — ceremony relocates into templates and config). §13's pattern table is binding: a rejected pattern returns only with its named condition met. This spec and `MIGRATION-PLAN.md`'s log are one provenance chain.

## 13. The orchestrator-worker pattern space (surveyed; binding verdicts)

The v1.x drafts occupied one point (star · ephemeral · orchestrator-decomposes · independent-verifier · disjoint-scope · flat-trust · push-brief · one-shot). The full survey, so the forest is on record:

| Pattern | Verdict | Reason |
| --- | --- | --- |
| Recursive self-delegation | **ADOPTED** (§5) | decomposition is discovered by working; leaf-only forced premature planning |
| Verification-intensity scaling | **ADOPTED** (§6.5) | the ledger already measures it; flat re-verify wastes the signal |
| Skeptic panel (N lenses, majority) | **ADOPTED, first-class** (§5) | proven this session — 5 lenses found 2 criticals a single check missed |
| Blackboard coordination | **ADOPTED — the ISA is one** (§5) | named so it's deliberate, not accidental; no separate mechanism |
| Speculative parallelism (K approaches, keep best) | **DEFER** `[OPEN: Q12]` | high value for path-uncertain work, but K× cost and the "best" selector is itself a judgment gate — needs a world-fact selector (whose tests pass) first |
| Persistent/warm specialist workers | **DEFER, bounded** `[OPEN: Q13]` | warm context helps execution but breaks verifier independence — implementers MAY warm within one ISA; skeptics never |
| Pull-based interactive workers | **DEFER** | cheaper than blocked-return-rebrief but host-dependent (R6 probe) and widens the interface; revisit if blocked rates are high |
| Consensus/voting on identical task | **REJECT** for execution | replay is cheaper & stronger; voting only helps irreducibly judgment-laden tasks, which §1 keeps with the orchestrator |
| Worker-to-worker mesh / negotiation | **REJECT** | large-interface + unverifiable coordination layer; the orchestrator integrates deterministically |
| Rotating/elected orchestrator | **REJECT** | no problem here needs it; pure complexity |

## 14. Decision provenance

Source artifacts: **claude-workers** spec+impl archived at `~/code/claude-workers/SPEC.md` (`D1–D19` = its §22 log, `§19` = eval, `H1–H12` = §3.1 host facts); **A7** = its home-conformance commit; the live run and H4/H6 probe results are in this session's ISA verification and `~/.claude-workers/conformance.json`. Element→evidence: R1/classifier-deletion ← mode-classifier.jsonl (p50 5,545ms, 39% E3+); R5/two-axis ← joint review 2026-06-12b; node recursion ← same; brief-content snapshot ← panel SEC-4; replay env/group-kill ← SEC-2/3; probe sandboxing ← SEC-1; evidential teeth ← GOODHART-1 (`lifecycle.ts:469`); provenance ranking ← GOODHART-2; WorktreeCreate ← P0 probe `"…not a directory: {}"` + EFFECT-4; lattice unification ← this restructure.

## 15. Open questions

`[OPEN: Q4]` classifier deletion is M2-evidence-conditional, not unconditional · ~~Q9 (nudge default)~~ **retired** — the nudge-to-invoke is removed entirely (§7); scaffolding self-scales, `/algorithm` is override-only · `[OPEN: Q10]` E3/E4/E5 templates vs one self-scaling template, post-eval · `[OPEN: Q11]` intensity-sampling curve & floor · `[OPEN: Q12]` speculative parallelism, pending a world-fact selector · `[OPEN: Q13]` implementer warm-context within an ISA. All await the migration's M2 observation week and/or your sign-off.

## 16. Adversarial review resolutions

Five-lens panel, 2026-06-12, against the v1.0 draft. 30 findings, all triaged (28 accept, 2 narrowed, 0 rejected); folded into the body. Abbreviated — full table in git history of this file's v1.1.

| Lens | Critical/major findings | Resolution home |
| --- | --- | --- |
| SECURITY | probe-channel RCE (#1); process-group kill unimplementable; env denylist≠allowlist; brief hash≠content TOCTOU; briefs/runs unconfined; verdict forgeable; agent-id source undefined | §6.3, §6.5 |
| GOODHART | evidential gate vacuously satisfiable; every channel author-controlled; nudge launders ceremony; scout relabel cosmetic; R8 unenforceable; stop_blocked_once skippable; soft_failed integration invisible | §6.4, §6.5, §7, R8, §8 |
| EFFECT | probe_verified_iscs migration nonexistent; checkpoint non-DI; contract rules in schema; WorktreeCreate error unencodable | §6.5, §6.4, §6 layer map, §4 |
| HOST | UPS 30s dead rationale; SubagentStop block-feedback probe-keyed; conformance gaps | §4, §8 |
| COHERENCE | task-integrity SPEC↔PLAN; gate-order self-contradiction; manual-flip vs PLAN rule 3; R3 didn't license its own gates; R4 vs WorktreeCreate; deleted-components/CUT drift + claude-subprocess orphan; Q4/9/10 hardened-while-open; missing invocation ledger; dangling provenance IDs; conformance dir | throughout; R3, R4, §9, §10, §14 |

**v2.0 note:** the restructure (five planes → node skeleton) is itself an unreviewed change. The "Safety + Seam = one verification lattice" merge and the recursion model have **not** faced the adversarial panel yet — that re-run is the gate before this header drops "pending review."

---

*v2.0 restructured solo around the recursive node after joint review 2026-06-12b. The v1.1 panel fixes are preserved and relocated; the new structure (§3, §5, §6 unification, recursion) is itself pending the next adversarial pass. Open items in §15 await your sign-off and the migration's M2 week.*
