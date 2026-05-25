# claude-hooks-ts

**A worker-and-policy system for Claude Code that makes the agent's process verifiable.** It enforces a Read-Plan-Implement loop (the ISA artifact must exist before any implementation tool runs), test-driven development (writes to `src/**` are denied without a companion test), classifier-driven engagement (the right ceremony for the actual scope of work), and bounded subagent delegation (at deep tiers, work is pushed to workers with a strict output contract). One Bun binary handles every one of Claude Code's 29 hook events through a strict schema, runs the payload through declarative policies, and emits the exact JSON Claude Code expects.

If you're running Claude Code in any context where "looks done" isn't good enough — production code, regulated work, anything you'd hate to debug later — this gives you receipts.

## What it enforces (the methodology)

| Pillar | Mechanism | Default |
| --- | --- | --- |
| **R**ead-**P**lan-**I**mplement (RPI) | Engagement gate denies non-ISA implementation tools until the per-task ISA artifact exists on disk; Stop gate blocks completion until the ISA's `## Test Strategy` ISCs are checked. | **on** for ALGORITHM tier ≥ E3 |
| **T**est-Driven Development | TDD-first PreToolUse gate denies `Write`/`Edit` on a non-test `src/**` file unless a companion test exists OR was touched in the same session (bootstrap-batch escape). | opt-in: `CLAUDE_HOOKS_TDD_GATE_ENABLED=1` |
| **Leveraged subagent workers** | At classifier tier ≥ E4, direct writes are recommended-asked or strict-denied unless a subagent is already active; `Task`/`Agent` launches get the worker contract injected and structured output enforced. | opt-in: `CLAUDE_HOOKS_WORKER_MANDATORY_MODE=recommend\|strict` |
| **Right-sized ceremony** | Sonnet mode classifier picks MINIMAL / NATIVE / ALGORITHM-E1..E5; an inflation guard floors E4/E5 verdicts to E3 when the prompt and recent context show no structural evidence; workflow-scoped source-ledger suppresses common-English false positives on coding/writing/ops tagged turns. | **on** |
| **Verifiable completion** | PostToolUse hot-loads `.claude-hooks/probes.ts` and flips ISC checkboxes on pass; `Stop` blocks until probes pass; opt-in auto-checkpoint commits when the repo is allow-listed. | probes auto-run; checkpoint opt-in via `checkpoint-repos.txt` |

---

## Why this exists

Claude Code fires a hook for every meaningful step in a session: `PreToolUse`, `Stop`, `PostToolUse`, `UserPromptSubmit`, `CwdChanged`, 24 more. Each hook is a chance to inject context, deny something dangerous, rewrite a tool input, or block a premature `Stop`. The default way to wire those up is per-event shell scripts. That falls over fast:

- No shared state between handlers, so you can't say "block Stop because the run produced no verifiable artifact."
- No schema for payloads, so you write defensive parsers in every script.
- No way to know whether a session was a 30-second one-shot or a 2-hour algorithmic effort — they get the same gates.
- No way to make doctrine (RPI, TDD, leveraged workers) into something the agent literally cannot bypass.

This package replaces that with one Bun binary. It decodes payloads against a strict Effect Schema, routes through 29 typed handlers (exhaustiveness enforced at compile time), writes a session ledger so what happened is reconstructible after the fact, and stacks the policy gates above so the methodology is a property of the system rather than a request in the prompt.

---

## Install

Requires [Bun](https://bun.sh).

```bash
bun add -g github:Esk3nder/claude-hooks-ts

claude-hooks-install --dry-run    # preview the settings.json merge
claude-hooks-install --apply      # atomic write with timestamped .bak backup

claude-hooks-doctor               # verify everything is wired
```

The installer merges hook entries into `~/.claude/settings.json` (or `--target <path>`), preserving unrelated keys. It's idempotent — rerunning replaces only its own entries. Backups go to `<target>.bak.<ISO-timestamp>` before any write. Uninstall: `claude-hooks-install --uninstall --apply`.

Per-project setup is **opt-in**:

```bash
cd your-project
claude-hooks-init                 # creates .claude-hooks/state/ only
claude-hooks-init --install-skills  # adds skill stubs to ~/.claude/skills/_bundled/
```

`claude-hooks-init` never touches `~/.claude/settings.json`, never spawns anything, and never installs skills unless you ask.

### Faster cold start (Linux)

```bash
bun run build:bin                 # produces dist/claude-hook-<platform>-<arch>
claude-hooks-install --apply      # auto-detects the binary, wires it directly
```

Cuts dispatcher cold-start by ~3x, paid on every tool call.

On macOS the compiled binary is unsigned and Gatekeeper may quarantine it, in which case every wired hook silently no-ops and `claude-hooks-doctor` reports `(missing)`. If that happens, switch to the bash shim:

```bash
claude-hooks-install --no-binary --apply
```

The shim (`bin/claude-hook`) is a small wrapper that `exec bun run`s the dispatcher and is not subject to Gatekeeper. You can also use `--no-binary` proactively on macOS to avoid the compile step. Linux installs default to the compiled binary.

---

## What it does, per hook

A few of the things wired into specific events:

- **`PreToolUse`** — denies edits to `protected-paths.yaml` entries, refuses writes to `generated-files.yaml`, blocks destructive shell patterns, gates ISA-required sessions to writing the spec first. Two opt-in policy gates compose on top: the **TDD gate** denies writes to `src/**` without a companion test in the same session, and the **worker-mandatory gate** denies direct writes at classifier tier ≥ E4 unless a subagent worker is active. Both are off by default — see [Opt-in policy gates](#opt-in-policy-gates).
- **`PreToolUse` + `SubagentStart` / `SubagentStop`** — turns marked `Task` / `Agent` launches into bounded workers by injecting scope/output contracts and requiring structured, evidenced output while leaving bare subagents alone.
- **`UserPromptSubmit`** — classifies the prompt's cognitive mode (MINIMAL / NATIVE / ALGORITHM with tier E1–E5), records the classification, and injects it as `additionalContext` so the model enters the right depth. Two follow-on normalizations protect against classifier noise: the **tier-inflation guard** floors E4/E5 verdicts to E3 when neither the prompt nor recent context shows structural evidence (code fences, ≥3 file paths, multi-step verbs, ISA refs); the **workflow-scoped source-ledger** suppresses weak research idioms ("current best practices", "state of the art") on confidently coding/writing/ops tagged workflows so the source-ledger Stop gate only fires on explicit web-research prompts. Conservative fail-safe to ALGORITHM E3 on any error.
- **`PostToolUse`** — runs your `.claude-hooks/probes.ts` (hot-loaded) against the active ISA; on pass, flips `[ ]` to `[x]` and auto-commits. Optional Read TLDR injection can add a capped structural overview for large code-file reads.
- **`Stop`** — blocks when the active ISA is `phase: complete` but tier-required sections are missing or ISCs are unchecked. When Claude Code exposes context usage, also blocks at the configured context-budget threshold unless the active ISA has a populated `## Handoff`. Runs declarative regenerate rules when source files changed.
  - **Per-task verify-map.** The active ISA's frontmatter may declare `verify_map_path: <relative-path-under-.claude-hooks/>`. If set, Stop loads that file with the repo verify-map's parser and additively concatenates its rules before selection. The existing priority/specificity tiebreak arbitrates conflicts (lower priority wins). Resolved paths must live under `<sessionRoot>/.claude-hooks/`; absolute paths, `..` escapes, malformed command arrays, and oversized (>64 KB) files are rejected with a warn-log. Missing files degrade silently to repo rules only.
- **`SessionEnd`** — archives completed ISAs to `.claude-hooks/archive/<YYYY-MM-DD>/<slug>/ISA.md`.
- **`PreCompact` / `PostCompact`** — snapshots active ISAs before model compaction and rehydrates them after as `additionalContext`.
- **`PermissionRequest` / `PermissionDenied`** — caches permission decisions per pattern; auto-replays answers on repeated prompts; respects denylist.
- **`CwdChanged`** — preserves frozen engagement state across project switches (so a Bash `cd` can't lose your active ISA); resets stale verification state only for non-engaged sessions.
- **`WorktreeCreate` / `WorktreeRemove`** — mirrors `.claude-hooks/` config into worktrees; archives ledger and completed ISAs back to the main repo on removal.
- **`Elicitation` / `ElicitationResult`** — caches MCP elicitation answers and auto-replays them.

Full per-event reference (inputs, outputs, behavior, edge cases) is in [`docs/HOOK-EVENTS.md`](./docs/HOOK-EVENTS.md). The worker-control-plane design is in [`docs/WORKER-ARCHITECTURE.md`](./docs/WORKER-ARCHITECTURE.md).

---

## Verify

```bash
claude-hooks-doctor
```

End-to-end checks: bun on `PATH`, `settings.json` parses, every wired hook command resolves and is executable, per-project state dir is writable, the dispatcher round-trips a synthetic payload, the classifier subprocess is reachable, and any active ISA's phase + progress match. Exits non-zero on FAIL. `--verbose` for details, `--json` for machine output, `--target <path>` to check a non-default settings file.

---

## Config

Everything project-local lives at `<project>/.claude-hooks/`. Defaults are baked in; every file below is optional.

```
.claude-hooks/
  protected-paths.yaml          # paths requiring confirmation before edit
  generated-files.yaml          # paths that cannot be edited
  test-map.yaml                 # changed file → smallest verify command
  research-domains.yaml         # whitelisted research source roots
  checkpoint-repos.txt          # allowlist for ISC auto-commit (opt-in, default empty)
  probes.ts                     # hot-loadable ISC verification probes
  regenerate.yaml               # source-changed → regenerate rules
  feedback/*.md                 # corpus for FeedbackMemoryConsult
  work/<slug>/ISA.md            # active task spec (you write these; git-tracked)
  archive/<date>/<slug>/ISA.md  # archived completed specs (git-tracked)
  state/                        # per-session ledgers, locks, telemetry (gitignored)
```

Override only what you need. Missing files mean the corresponding policy is inert, not the dispatcher.

### Probes — auto-verify ISC criteria

`<project>/.claude-hooks/probes.ts` is hot-loaded on every `PostToolUse`:

```ts
// .claude-hooks/probes.ts
export const probes = {
  "typecheck": async () => {
    const r = await Bun.spawn(["bun", "run", "typecheck"]).exited
    return r === 0
  },
  "tests": async () => {
    const r = await Bun.spawn(["bun", "test"]).exited
    return r === 0
  },
}
```

In your ISA's `## Test Strategy` section, name the probe per criterion (`tool` column). When a probe returns `true`, the matching `- [ ] ISC-N` flips to `- [x]` and — if the repo is in `.claude-hooks/checkpoint-repos.txt` — a checkpoint commit is made. The allowlist is empty by default; **nothing is auto-committed unless you opt the repo in.**

Probes run with full Node privileges in the dispatcher process (same boundary as `make` or `npm test`). Each one is wrapped in a 1s timeout and a catch-all; failure to load or run is treated as non-passing, never as a crash.

### Opt-in policy gates

These optional features are **off by default**. Set the env vars to enable. The TDD and worker-mandatory gates run at PreToolUse, inside the engagement-gate block, so they only fire on sessions where the engagement gate is already active.

```bash
export CLAUDE_HOOKS_TDD_GATE_ENABLED=1
export CLAUDE_HOOKS_WORKER_MANDATORY_MODE=recommend   # or "strict" or "off"
export CLAUDE_HOOKS_READ_TLDR_ENABLED=1
```

**TDD gate.** When enabled, denies `Write` / `Edit` / `MultiEdit` / `NotebookEdit` on a non-test file under `src/**` unless a companion test exists on disk OR was touched in the current session. Companion candidates for `src/foo/bar.ts` are `src/foo/bar.test.ts` (inline), `src/foo/__tests__/bar.test.ts`, and `test/foo/bar.test.ts` (mirrored test/ tree). `.spec.ts` and matching-extension (`tsx`, `js`) variants also accepted. Bootstrap-batch escape: when the test file appears in this session's `files_changed`, the implementation write is allowed — so a fresh feature can ship by writing the test first, then the implementation.

**Worker-mandatory gate.** When enabled, the gate fires only when `last_tier >= 4` and the tool is a direct write (`Write` / `Edit` / `MultiEdit` / `NotebookEdit` / `Update`):

| Mode | Behavior |
| --- | --- |
| `off` (default) | passthrough — no change |
| `recommend` | `ask` with a hint pointing at the Task tool |
| `strict` | `deny` with the same hint — model MUST launch a Task first |

A live subagent (one or more `SubagentStart` not yet matched by `SubagentStop`) grants passthrough — workers are the delegation target. Worker sessions themselves (detected via `CLAUDE_HOOKS_WORKER_ID` set by the harness) are always passthrough so the gate never deadlocks a subagent's own writes.

**Read TLDR injection.** When enabled, `PostToolUse` for `Read` injects a Markdown overview for first-slice reads of large `ts` / `tsx` / `py` / `go` files. The line threshold defaults to 400 and can be changed with `CLAUDE_HOOKS_READ_TLDR_MIN_LINES=<n>`. Summaries list imports, top-level symbols, public exports, and local call sites, are capped at 50 lines, and are cached by file mtime+size under `~/.claude-hooks/state/tldr-cache/`.

**Context-budget Stop gate.** When context usage is available in Stop payload metadata or the transcript tail, Stop blocks at 85% by default unless the active ISA has a populated `## Handoff` that links every active ISC. Set `CLAUDE_HOOKS_CONTEXT_BUDGET_THRESHOLD_PCT=0` to disable it, or set another integer percentage from 1 to 100.

### Disable the classifier

```bash
export CLAUDE_HOOKS_DISABLE_CLASSIFIER=1
```

When set, `UserPromptSubmit` skips the Sonnet subprocess and returns the deterministic ALGORITHM E3 fail-safe. Useful for CI runners without a `claude` CLI on `PATH`, perf benchmarks, and red-team runs.

---

## Logs and tracing

Every decision is written to a per-session JSONL ledger at `.claude-hooks/state/<sessionId>/ledger.jsonl`. Cross-process file locks keep parallel Claude Code sessions from corrupting state. Approvals and elicitations have their own caches under `.claude-hooks/state/`.

Tail a live session:

```bash
claude-hooks-tail                              # all sessions in cwd
claude-hooks-tail --session <id>               # a specific session
claude-hooks-tail --since 2026-05-01           # only events after timestamp
claude-hooks-tail --cwd /other/project         # another project's ledger
```

Inspect classifier telemetry:

```bash
tail -f .claude-hooks/state/observability/mode-classifier.jsonl | jq .
```

For OTel traces:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces claude
```

Tracing is fully no-op when the env var is unset — zero import cost. Nothing is sent off-machine by default.

---

## Safety posture

The dispatcher is designed to fail closed in the right direction:

- **Schema decode fails** → hook-safe fallback, exit 0. Malformed `PreToolUse` asks instead of silently allowing.
- **Handler throws or times out** (4s default; 30s for `UserPromptSubmit`) → `SAFE_DEFAULT` with typed failure diagnostics.
- **Classifier subprocess errors** → fail-safe to ALGORITHM E3 (over-escalate, never under-escalate).
- **Probes fail to load or throw** → ISC stays `[ ]`, no commit, warning logged.
- **Checkpoint allowlist missing or repo not in it** → no commit. Ever.

The auto-checkpoint never resets, reverts, or force-pushes. It runs `git add` on the ISA and the touched files only, and commits with `--no-verify --no-gpg-sign` to a 5-second timeout.

All `claude` subprocess invocations are funneled through `src/services/claude-subprocess.ts`, which scrubs `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDECODE` from the child environment so OAuth billing is never silently shadowed by an API key. A CI guard (`bun run lint:claude-spawn`) refuses to build if any direct `claude` spawn exists outside that chokepoint.

---

## Contributing

```bash
bun install
bun run typecheck
bun test                           # 110+ test files, Bun's native test runner
bun run lint:claude-spawn          # CI guard: no direct `claude` spawns outside the chokepoint
```

Conventions enforced by the codebase, not just the docs:

- TypeScript `strict` plus `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `noFallthroughCasesInSwitch`.
- No `any`, no `// @ts-ignore`, no skipped tests.
- Side effects through services in `src/services/`. Policies as pure functions in `src/policies/`. Event handlers in `src/events/`. Schemas in `src/schema/`. ISA / classifier code under `src/algorithm/`.
- All imports use the explicit `.ts` extension (`bundler` resolution with `allowImportingTsExtensions`).
- Exhaustive event routing in `src/dispatcher.ts` via `Match.tagsExhaustive` — adding an event without a handler is a type error.

---

## Confirming the methodology

The methodology system (RPI engagement, TDD-first gates, mandatory leveraged workers, right-sized ceremony) is enforced by handlers in `src/events/` and proven end-to-end by the fixture suite in `test/integration/methodology/`. A single script gates the whole thing:

```bash
bash scripts/confirm-methodology.sh
```

Exit 0 means:

- `bun run typecheck` is clean
- `bun test test/integration/methodology/` is green
- the suite still contains at least 17 fixture tests (today: 19)

On success the last line is `✓ Methodology enforced end-to-end`. On failure the script names the gate that failed and tails the relevant log. `--help` prints usage. `CONFIRM_METHODOLOGY_DRY_RUN=1` skips the heavy steps and only emits the summary — used by the script's own smoke test in `test/scripts/confirm-methodology.test.ts`.

---

## Security

Threat model, mitigations inventory with `file:line` audit refs, known gaps, and disclosure path live in [`SECURITY.md`](./SECURITY.md). Report vulnerabilities via GitHub Security Advisories.

## License

See [`LICENSE`](./LICENSE).
