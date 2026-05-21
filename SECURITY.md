# Security policy

`claude-hooks-ts` intercepts every Claude Code tool call and decides whether to allow, ask, deny, or rewrite. That makes the hook layer a security-sensitive choke point: a regression in any policy file can silently widen the model's capability beyond what the user authorized. This document is the honest accounting of what we protect against, what mitigations are in place, and what gaps remain open.

It is written for two readers: (1) a security reviewer auditing whether to install this package in a dev environment, and (2) a contributor who needs to know which behaviors are load-bearing and must not regress.

---

## Reporting a vulnerability

**Channel:** Use [GitHub Security Advisories](https://github.com/Esk3nder/claude-hooks-ts/security/advisories/new) on this repository. Public issues are appropriate only after a fix has shipped or the maintainer has explicitly cleared disclosure.

**Triage window:** Best-effort. This is a small project; expect days, not hours.

**Scope:** Anything that bypasses an in-place policy gate, exfiltrates a Claude API key past `scrubClaudeEnv`, escalates worker privilege beyond the contract injected by `worker-contract.ts`, or causes silent data loss in session state.

**Out of scope:** Reports against the upstream Claude Code runtime, against MCP servers we don't ship, against transitive dependencies' general known CVEs (use `bun audit` or `npm audit` — those are upstream).

---

## Scope

This document covers the code under `src/`, `scripts/`, and `bin/` shipped in published versions of `claude-hooks-ts`. It does NOT cover:

- The Claude Code CLI / runtime itself (Anthropic).
- The `claude` subprocess invoked for classifier inference (`src/services/claude-subprocess.ts:84-99`). We treat the subprocess as in the user's trust domain — the user already gave it credentials.
- Third-party MCP servers a user installs into their Claude Code instance.
- The user's own ISA files, probe scripts, allowlists, and `verify-map.yaml` rules (treated as user-authored configuration).

---

## Trust boundaries

| Boundary | What's on each side |
| --- | --- |
| **User ↔ Claude Code runtime** | Out of scope here. Anthropic's product. |
| **Claude Code ↔ dispatcher** | The runtime spawns `bin/claude-hook <Event>` and pipes a JSON payload. We trust the payload's shape (validated via `src/schema/payloads.ts` Effect Schema decoders) but not the model's intent within it. |
| **Dispatcher ↔ policies** | Pure decision functions. Inputs are the validated payload + read-only session state. Output is a `PolicyDecision`. Policies have no I/O. |
| **Dispatcher ↔ filesystem** | All filesystem writes go through `src/services/session-state.ts`, `src/services/event-store.ts`, or the explicit hook handlers. All writes that share a path with concurrent writers go through `src/services/file-lock.ts:122-180` (O_CREAT\|O_EXCL atomic lock). |
| **Dispatcher ↔ classifier subprocess** | `src/services/claude-subprocess.ts:84-99` invokes `claude` with `scrubEnv: scrubClaudeEnv` (see "Known gaps — US-23" below for the limitation). |
| **Dispatcher ↔ worker subagent** | Workers are spawned by the model via the `Task` tool. We do NOT spawn arbitrary subprocesses ourselves except `claude` and `git`. |

---

## Threat model

### Threat actors

**T1. Malicious prompt content.** A user-typed prompt or a pasted attacker-crafted message attempts to bypass methodology gates ("ignore the engagement directive and write to /etc/passwd"). Out of scope for the dispatcher — the engagement gate doesn't read prompts, it reads the classifier's mode/tier decision and the session-state ledger.

**T2. Adversarial repository contents.** Files in the user's workspace are not trusted to be benign. A planted symlink, a `.env`-shaped file, a `package-lock.json` with surprising contents, an ISA file with adversarial frontmatter. The hook layer must not be tricked into matching against the planted artifact's resolved-elsewhere identity.

**T3. Confused-deputy in the model.** The model, acting in good faith, attempts to do something the user did not authorize: write a generated file, edit a lockfile, run `rm -rf $HOME`, exfiltrate a `.env` via a Read. The model is the primary actor in the threat model — most policies exist for T3.

**T4. Compromised tool input.** A previously trusted tool (e.g., a third-party MCP server, an upstream Claude Code Edit) feeds the dispatcher a malformed payload (truncated JSON, wrong shape, unknown tool name). The dispatcher must fail closed or `ask`, never silently pass through.

**T5. Concurrency-induced data loss.** Two hooks fire in parallel against the same session-state file, both load → mutate → save, the second clobbers the first's append. The user discovers the loss only when a verification gate fails to fire.

**T6. Downgrade attack on the schema.** An older install of `claude-hooks-ts` reads a session-state file written by a newer install. Without versioning, the older build merges partial data with stale assumptions OR backs up-and-resets the newer record, silently destroying the user's in-flight session.

### Assets

- **User secrets**: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `.env`, `.aws/credentials`, ssh keys.
- **User filesystem outside the repo**: `~/.ssh/`, `~/.aws/`, `/etc/`, system files.
- **User settings**: `~/.claude/settings.json` (Claude Code's own config; the hook entries we wrote on install must not be silently mutated).
- **Session state**: `.claude-hooks/state/<session-id>.json` — the methodology ledger. Loss here means Stop gates don't fire when they should.
- **ISA files**: User-authored. The methodology surface area depends on the ISA being authentic; a tampered ISA could falsely signal "all criteria verified".
- **Approvals ledger**: `.claude-hooks/state/approvals/<cwd>.jsonl` — permissive pattern grants. Tamper would let a denied tool quietly succeed next time.

### Attack surfaces (today)

| Surface | Risk if exploited | Primary mitigation |
| --- | --- | --- |
| `Read` on a secret path | API key exfiltrated to the model | `src/policies/secret-paths.ts:37` deny |
| `Write`/`Edit` to `.env`, lockfile, settings.json | Credential leak / supply-chain | `src/policies/secret-paths.ts:37` + `src/policies/lockfile-paths.ts:21` + `src/policies/settings-self-protection.ts:25` |
| Generated-file overwrite (`*.lock`, `dist/*`, generated stubs) | Loss of source-of-truth | `src/policies/generated-files.ts:98` |
| Destructive Bash command (`rm -rf /`, `git push --force`) | System destruction | `src/policies/destructive-commands.ts:46` |
| Protected path edits (CI files, lockfiles) | Hidden CI bypass | `src/policies/protected-paths.ts:21` |
| Classifier subprocess inherits API key | Key leaks into `claude` invocation | `src/services/claude-subprocess.ts:70-82` (`scrubClaudeEnv`). **Partial — see US-23.** |
| Implementation write before ISA scaffolding | Methodology bypass | `src/policies/engagement-gate.ts:331` |
| Source write without companion test | TDD bypass | `src/policies/tdd-gate.ts:251` |
| Symlink-resolved escape in TDD gate | Wrong-companion match | `src/policies/tdd-gate.ts:210` (`safeRealpath`, P0-4) |
| Worker subagent escapes its contract | Privilege escalation | `src/policies/worker-permissions.ts:569` |
| Concurrent session-state appends lose data | Ledger inconsistency | `src/services/file-lock.ts:122` + `src/services/session-state.ts` write paths |
| Downgrade attack on session-state JSON | Silent data loss / corruption | `src/services/session-state.ts:299` `detectFutureSchemaVersion` (P0-5) |
| Log line includes API key / token | Credential leak via logs | `src/services/redact.ts:50` |

---

## Mitigations

Each entry below names the mitigation, what it defends against, where it lives, and what's known to be incomplete (if anything). All references are `file:line` against `main` so a reviewer can audit each claim. If a referenced line has moved by the time you read this, the test at `test/security-md.test.ts` should be failing.

### Secret-path read/write deny

- **Where:** `src/policies/secret-paths.ts:5` (glob list) + `src/policies/secret-paths.ts:37` (decision function).
- **What:** Reads or writes to `.env`, `.env.*`, `**/credentials.json`, `~/.ssh/id_*`, `**/.aws/credentials`, etc. are denied with a usable error pointing to the matched glob.
- **Wired by:** `src/events/pretool-policy.ts:51` (read context) and `:59` (write context).
- **Known limitation:** Coverage is path-based. A secret pasted into an unrelated path (e.g., a developer paste-bin file at `notes.txt`) is not detected. The `content-scan.ts` policy is a partial complement but is not on the deny path.

### Protected-path edit ask

- **Where:** `src/policies/protected-paths.ts:5` (glob list) + `:21` (decision function).
- **What:** Edits to CI files (`.github/workflows/**`), `package.json` outside `dependencies`, etc. trigger an `ask` so the user must confirm. Not a deny because legitimate edits to these paths are common.
- **Wired by:** `src/events/pretool-policy.ts:57`.

### Destructive command deny

- **Where:** `src/policies/destructive-commands.ts:7` (DENY_PATTERNS) + `:33` (ASK_PATTERNS) + `:46` (decision function).
- **What:** Bash commands matching `rm -rf /` patterns, `git push --force` against main/master, `chmod 777`, etc. The list is conservative — it explicitly does NOT cover routine destructive commands (`git checkout -- .`, `git reset --hard`) which the user often legitimately wants. Those are user-judgment territory.
- **Wired by:** `src/events/pretool-policy.ts:88` (the Bash branch).
- **Known limitation:** Heredoc-style file writes via Bash (`cat > src/foo.ts <<EOF`) are not matched here and not currently denied by `worker-mandatory.ts` either — surfaced by the Opus enforcement-plane diligence as P0 #6 (see "Known gaps" below).

### Generated-file deny

- **Where:** `src/policies/generated-files.ts:14` (rules list) + `:98` (decision function).
- **What:** Writes to known generated outputs (e.g., `docs/CLASSIFIER_CONTRACT.json` per US-22) are denied with a regenerator pointer.
- **Wired by:** `src/events/pretool-policy.ts:55`.

### Lockfile edit ask

- **Where:** `src/policies/lockfile-paths.ts:5` (globs) + `:21` (decision function).
- **What:** Edits to `package-lock.json`, `bun.lockb`, `yarn.lock`, etc. trigger an `ask`. Most legitimate lockfile updates come from `bun install`, not from a model's `Edit`.
- **Wired by:** `src/events/pretool-policy.ts:56`.

### Claude Code settings self-protection

- **Where:** `src/policies/settings-self-protection.ts:8` (globs) + `:25` (decision function).
- **What:** Direct edits to `~/.claude/settings.json` are denied. Users must use `claude-hooks-install --apply` (which atomically merges and backs up the prior file).
- **Wired by:** `src/events/pretool-policy.ts:54`.

### Inspection-command allowlist (verification gate input)

- **Where:** `src/policies/inspection-whitelist.ts` (the whole file).
- **What:** User-supplied per-project `.claude-hooks/inspection-whitelist.yaml` declares which commands count as "verification" for the Stop gate. Defensive parser rejects unsafe entries (`rm -rf /`, `cat secrets > /tmp/out`, `curl http://evil`, shell metacharacters) and logs the rejection.
- **Why:** Without this, a user could declare `rm -rf /` as "a verification command" and the Stop gate would happily run it. Conservative parser is the line of defense.

### TDD-gate companion test requirement + symlink containment

- **Where:** `src/policies/tdd-gate.ts:210` (`safeRealpath` — P0-4) + `:251` (`evaluateTddGate`).
- **What:** With `tddGateEnabled=true`, writes under `src/**` require a companion test. The path comparison realpath-resolves both sides BUT refuses to honor a symlink that escapes the repo root (the P0-4 fix). Without containment, a planted symlink `<repo>/test/foo.test.ts → /external/anything.ts` could trick the gate into matching against an out-of-repo `files_changed` entry.

### Engagement gate (methodology choreography)

- **Where:** `src/policies/engagement-gate.ts:233` (pure shallow) + `:331` (deep entry).
- **What:** When the classifier flags ALGORITHM tier ≥3, non-ISA writes are denied until the expected ISA file exists. Forces the model to scaffold the ISA artifact before doing implementation work.
- **Unknown / MCP tool ask during pre-ISA engagement** (enforcement-plane P0 #3, closed): `src/policies/engagement-gate.ts:323` — pre-fix this fell through to passthrough, letting an MCP write-shaped tool (`mcp__filesystem__write_file`, `mcp__repo__apply_patch`) bypass the no-implementation-before-ISA invariant. Now: `evaluateEngagementGateShallow` calls `isUnknownTool(toolName)` from `src/policies/write-class.ts:120` and returns `ask` when engagement is required and no ISA exists yet, so the user explicitly confirms read-only intent or scaffolds the ISA first.
- **Known limitations:** See "Known gaps" — the Opus enforcement-plane diligence on 2026-05-20 confirmed several remaining bypasses (#1 stale project ISA, #4 corrupt state fails open).

### Unified write-class tool surface (P0 #2 + #6 closed)

- **Where:** `src/policies/write-class.ts:22` (WRITE_CLASS_TOOLS) + `:39` (mutablePathFromInput) + `:92` (isBashFileWrite) + `:120` (isUnknownTool).
- **What:** Single source of truth for "is this tool a file-writing operation?". Before this module, each enforcement gate rolled its own definition; `Update` / `NotebookEdit` skipped the write-path policies (`src/events/pretool-policy.ts:148` switch routed only Edit/Write/MultiEdit), and Bash heredoc writes bypassed worker-mandatory strict (`src/policies/worker-mandatory.ts:99` checked toolName only, not Bash commands). Both closed: `pretool-policy.ts` now routes Update + NotebookEdit through the same write-path reducer (extracting `notebook_path` for the latter via `mutablePathFromInput`), and `worker-mandatory.ts` accepts an optional `bashCommand` field that triggers `isBashFileWrite` detection on `cat > x <<EOF`, `tee`, `sed -i`, `python -c open().write`, `node -e writeFileSync`, `cp`, `mv`, `touch`, `git apply`, and `dd of=`.

### Worker capability bounds

- **Where:** `src/policies/worker-permissions.ts:250` (worker-id derivation) + `:429` (path-in-scope check) + `:569` (per-tool permission decision).
- **What:** Spawned `Task` workers are issued a contract specifying paths they may write. Writes outside the contract are denied. The contract is injected at worker spawn (`src/policies/worker-contract.ts`) and replayed at SubagentStop (`src/policies/worker-verification-replay.ts`) to verify the worker's claims.

### Concurrency-safe ledger writes

- **Where:** `src/services/file-lock.ts:122` (`acquireLock` — O_CREAT|O_EXCL + pid-liveness + stale recovery) + `:190` (`withLock`).
- **What:** All three session-state write paths (`update`, `appendBatch`, `reset`) wrap their read-modify-write in `withLock`, as does the checkpoint state writer (P0-1). Two concurrent appends cannot lose each other's entries.
- **Pinned by:** `test/services/session-state-concurrency.test.ts` + `test/algorithm/isa/checkpoint-concurrency.test.ts`.

### Schema versioning + downgrade refusal

- **Where:** `src/services/session-state.ts:129` (`SESSION_STATE_SCHEMA_VERSION`) + `:299` (`detectFutureSchemaVersion`).
- **What:** Session-state records carry a `_schema_version` stamp. A record from a newer build (higher `_schema_version`) is **refused with a loud warning** — the older build returns `EMPTY_SESSION_STATE` and leaves the on-disk record untouched. A downgrade does NOT silently merge unknown fields and does NOT back-up-and-reset the newer file.

### API-key scrubbing on subprocess spawn

- **Where:** `src/services/claude-subprocess.ts:70` (`scrubClaudeEnv`) + `:94` (wired into the spawn).
- **What:** Before spawning the `claude` subprocess for classifier inference, the env is filtered: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDECODE` are stripped. The subprocess gets `CLAUDE_CODE_OAUTH_TOKEN` and the rest of the user's env.
- **Known incomplete:** Bun re-injects `CLAUDECODE=1` into child processes when the parent is a Claude Code session, bypassing this scrub. Filed as **US-23** in `docs/USER_STORIES.md`.

### Log redaction

- **Where:** `src/services/redact.ts:50` (`RedactLive`).
- **What:** Structured log lines pass through a redactor that masks tokens matching known credential patterns. Used by `logWarningSync` and the hook-failure reporter so a stack trace dumping the env can't accidentally leak a key.

---

## Known gaps

These are the things we have NOT closed yet. Each is filed in the backlog with a US-* id and (where applicable) a verified `file:line` of the offending behavior. The honest disclosure is part of the security posture: a `SECURITY.md` that pretended these were closed would be lying.

### US-23 — CommandRunner env-scrub vs. Bun parent-process injection (CLOSED 2026-05-20)

Investigation result: Effect's `Command.env(cmd, scrubbed)` is **additive** — the BunCommandExecutor merges our scrubbed env with the parent `process.env` at spawn time (verified directly via the Effect platform-bun API). Dropping `CLAUDECODE` from the scrubbed record let the parent's value re-inject in the merge. Fix: `src/services/claude-subprocess.ts:70-100` `scrubClaudeEnv` now MASKS scrubbed keys with an empty string instead of DROPPING them, AND unconditionally adds them to the output (even when absent from the source) — so the explicit `""` overrides the parent's value in the executor's merge. The previously-failing `test/services/command-runner.test.ts:78` is now green, and a new positive test (`:96-119`) asserts `CLAUDECODE` is absent from the child env even when only the parent shell sets it.

### Enforcement-plane P0s — CLOSED 2026-05-20

The three P0 bypasses surfaced by the Opus diligence have been fixed in a single unified-write-class refactor (see Mitigations above). The fixes:

- **#2 (`Update`/`NotebookEdit` bypass) — closed** by `src/events/pretool-policy.ts:148-152` extending the switch to route Update + NotebookEdit through `evaluateUpdateOrNotebookEdit`, which uses `mutablePathFromInput` to read `notebook_path` for NotebookEdit.
- **#3 (MCP/unknown tool passthrough) — closed** by `src/policies/engagement-gate.ts:323-345` calling `isUnknownTool` and returning `ask` when no ISA exists yet.
- **#6 (Bash heredoc bypass) — closed** by `src/policies/worker-mandatory.ts:101-105` extending the gate predicate to include `isBashFileWrite(bashCommand)` matches.

### Enforcement-plane P1s — CLOSED 2026-05-20

The 4 P1 bypasses surfaced by the Opus diligence are all fixed:

- **#1 (stale project ISA) — closed** by `src/algorithm/isa/lifecycle.ts:194-211` adding a freshness check: when `engagement_required` and `isa_engaged_at` are set, `resolveActiveIsa` only honors the project ISA when its mtime ≥ `Date.parse(isa_engaged_at)`. Legacy callers (no `isa_engaged_at`) keep the previous "any project ISA wins" behavior.
- **#4 (corrupt-state fail-open) — closed** by `src/policies/engagement-gate.ts:363-381` returning `kind: "ask"` with a repair message when `engagement_required=true` AND `expected_isa_path === null`. Pre-fix this returned passthrough, disabling the gate exactly when state said engagement was required.
- **#5 (NotebookEdit invisible to files_changed) — closed** by `src/events/post-edit-quality.ts:31-41` adding `NotebookEdit` to `EDIT_TOOLS` and `src/events/post-edit-quality.ts:79-85` using the canonical `mutablePathFromInput` from `src/policies/write-class.ts` to read `notebook_path` as well as `file_path`.
- **#7 (source_ledger_opt_out carryover) — closed** by `src/events/prompt-router.ts:129-143` extending the requires-web-sources branch of `workflowPatch` to include `source_ledger_opt_out: false`. Pre-fix, an opt-out from a prior ISA would leak into a subsequent web-source-required task and suppress the Stop source-ledger gate.

### Enforcement-plane P2s — CLOSED 2026-05-20

- **#8 (verification relevance) — closed** by `src/services/session-state.ts:60-77` adding optional `verification_command` and `verification_files` fields (back-compat: both optional), `src/events/post-edit-quality.ts:198-222` recording the literal command + intersection of `files_changed` and command-mentioned basenames (stem-match heuristic) when verification flips to `"passed"`. Record-only at P2 — no new blocking behavior, but a reviewer can now see WHICH run counted and which paths it covered.
- **#9 (glob `*` matches `/`) — closed** by `src/policies/verify-map.ts:181-219` rewriting the glob compiler: single `*` is single-segment (`[^/]*`), double `**` is multi-segment (handled by tokenizing and special-casing `/`-adjacent positions so `src/**/foo.ts` matches `src/foo.ts`, `src/a/foo.ts`, `src/a/b/foo.ts`). Standard glob semantics now hold.

### Supply chain

We do NOT currently:

- Publish an SBOM with releases.
- Sign release binaries (macOS Gatekeeper kills our unsigned binaries — documented in `.github/workflows/ci.yml`).
- Pin transitive dependencies past `bun.lockb` (which is committed).

Mitigation today is "review dependencies before bumping". This is a real gap on the supply-chain axis. Filed as a follow-up.

---

## Out of scope

- **Network-attached threat actors.** The dispatcher does no network I/O of its own. The only outbound network is the `claude` subprocess invoking Anthropic's API on the user's behalf, which is in scope for Claude Code itself.
- **Multi-user / multi-tenant systems.** This package is a single-user developer tool. File permissions, locks, and ledgers assume one human + one Claude Code instance per workspace.
- **Sandboxing the model.** We constrain what the model can do via policy gates, but we do not run the model in a sandbox. That is upstream Claude Code's responsibility.
- **Defeating a sufficiently motivated insider.** A user can disable any gate via `CLAUDE_HOOKS_*_DISABLED` runtime config flags. These exist for operational unblocking, not for security; they are documented escape hatches.

---

## Versioning

This document is `v1` (P0-3). Future revisions are tracked in `git log SECURITY.md`. When a "known gap" is closed, the entry moves to "Mitigations" with the `file:line` of the fix. When a new attack surface is documented, the mitigations table grows.
