# claude-hooks-ts

A type-safe dispatcher for [Claude Code](https://docs.claude.com/claude-code) hooks — **with the PAI Algorithm primitive wired in.**

Replaces ad-hoc per-hook shell scripts with a single binary that decodes hook payloads through a strict schema, runs them through declarative policies, and emits the structured JSON Claude Code expects. One control plane for safety, quality, token efficiency, verification gates, audit, **plus mode classification, ISA tracking, capability auditing, and Stop-time completeness gates** that turn an LLM session into a verifiable Algorithm run.

---

## What it does

Two layers, both in one dispatcher:

### Hooks layer (the original claude-hooks-ts)

Claude Code fires a hook event (e.g. `PreToolUse`, `Stop`, `PostToolBatch`) for every meaningful step in an agent session. Each event is a chance to inject context, deny dangerous actions, rewrite tool inputs, or block premature stops. claude-hooks-ts wires a single dispatcher into all 29 events and routes each one through purpose-built handlers.

A few things it does out of the box:

- **Denies secret reads** (`.env`, private keys, credential files) and destructive commands (`rm -rf`, `git reset --hard`, `terraform destroy`)
- **Asks before** editing lockfiles, settings, migrations
- **Blocks `Stop`** when files were changed without a verification command being run
- **Auto-replays** prior `PermissionRequest` decisions and MCP `Elicitation` answers
- **Surfaces recent failures** (`rate_limit`, `auth`) at session start so the agent plans around them
- **Resets session state** when you `cd` into a different project (no cross-project bleed)
- **Mirrors your `.claude-hooks/` config into worktrees** so policies follow you
- **Archives ledgers** before worktree removal so audit history isn't lost
- **Scans tool responses for secrets** and surfaces a warning before the model re-emits them

### Algorithm layer (1.0.0)

The PAI Algorithm primitive — ported faithfully from `~/.claude/PAI/ALGORITHM/v6.3.0.md`:

- **Mode classifier on every prompt.** A Sonnet subprocess (via `claude --print`, OAuth-billed) decides `MINIMAL | NATIVE | ALGORITHM` and a tier `E1`-`E5`. Result emitted as `additionalContext` so the model enters the right cognitive depth automatically. Conservative fail-safe to ALGORITHM E3 on any error.
- **ISA primitive.** 12-section spec from `IsaFormat.md`, with parsers for frontmatter, criteria (with v5.3-era backward-compat), section walker, ID-stability validator, and tier-completeness gate.
- **ISC checkpoint.** When an ISA's `[ ]` flips to `[x]`, auto-commit the working tree in any opted-in repo (allowlist at `.claude-hooks/checkpoint-repos.txt`). Empty by default — opt-in only.
- **ISC probes.** Hot-loadable `<repo>/.claude-hooks/probes.ts` runs on every PostToolUse; passing probes flip ISC checkboxes (which then trigger checkpoint commits).
- **Stop ISA gate.** When ISA `phase: complete` but tier-required sections are missing OR ISCs are unchecked, Stop is blocked with a model-actionable reason.
- **TaskCompleted ISC-evidence requirement.** Task can't be marked complete if the active ISA still has unchecked criteria or an empty Verification section.
- **Capability phantom audit.** Closed enumeration of 19 thinking-capability names from Algorithm v6.3.0 doctrine. `auditCapabilityNames(selected)` rejects paraphrases.
- **Compaction preserves ISA context.** PreCompact snapshot includes active ISAs; PostCompact rehydrates them as additionalContext.
- **Session-end archive.** ISAs in `phase: complete` are archived to `.claude-hooks/state/archive/<YYYY-MM-DD>/<slug>/ISA.md`.
- **Doc-integrity regen.** Declarative `<repo>/.claude-hooks/regenerate.yaml` rules run at Stop when source files changed.
- **Telemetry.** Every classification logged to `.claude-hooks/state/observability/mode-classifier.jsonl` for weekly audit (classifier-vs-fail-safe ratio, latency p50/p95).

Every decision is recorded to a per-session JSONL ledger. Optional OpenTelemetry export for spans. Cross-process file locks so parallel Claude Code sessions can't corrupt state.

See [`docs/HOOK-EVENTS.md`](./docs/HOOK-EVENTS.md) for the full per-event reference.

---

## Install

Requires [Bun](https://bun.sh).

```bash
bun add -g github:Esk3nder/claude-hooks-ts
claude-hooks-install --dry-run                  # preview the merge first
claude-hooks-install --apply                    # write atomically with .bak backup
claude-hooks-init                               # create per-project state dir
claude-hooks-init --install-skills              # opt-in skill bundle (~/.claude/skills/_bundled/)
claude-hooks-doctor                             # verify wiring + algorithm setup
```

The installer merges hook entries into `~/.claude/settings.json` (or `--target <path>`), preserving unrelated keys. The previous file is backed up to `<target>.bak.<ISO-timestamp>` before any write. Install is idempotent.

`claude-hooks-init` is opt-in for everything destructive — it does NOT touch `~/.claude/skills/` unless you pass `--install-skills`. The default skill install namespaces under `_bundled/` to avoid colliding with your existing skills; pass `--into-root --force` for the flat layout.

To uninstall:
```bash
claude-hooks-install --uninstall --apply
```

### Faster cold start (Linux)

By default, hooks run via `bun run`. On Linux you can compile to a single binary instead — cuts dispatcher cold-start by ~3x:

```bash
bun run build:bin                      # produces dist/claude-hook-<platform>-<arch>
claude-hooks-install --apply           # auto-detects the binary, wires it directly
```

Force the bun-run path with `--no-binary`. macOS auto-falls back since unsigned compiled binaries are killed by Gatekeeper.

---

## Verify

```bash
claude-hooks-doctor
```

End-to-end checks: bun on PATH, settings.json parseable, wired hook commands resolve, state dir writable, dispatcher round-trip succeeds, **classifier subprocess available, classifier billing path, thinking-capability skill stubs installed, active ISA + phase + progress**. Exits non-zero on any FAIL. Use `--verbose` for details, `--json` for machine output.

---

## Configure

Project-local config lives at `<project>/.claude-hooks/`:

```
.claude-hooks/
  protected-paths.yaml          # paths requiring confirmation before edit
  generated-files.yaml          # paths that cannot be edited
  test-map.yaml                 # changed-file → smallest verify command
  research-domains.yaml         # whitelisted research source roots
  checkpoint-repos.txt          # allowlist for ISC auto-commit (opt-in, default empty)
  probes.ts                     # hot-loadable ISC verification probes (opt-in)
  regenerate.yaml               # source-changed → regenerate command rules
  feedback/*.md                 # FeedbackMemoryConsult corpus
  state/                        # per-session ledgers (managed by hooks)
  state/observability/          # classifier telemetry JSONL
  state/work/<slug>/            # task ISAs
  state/archive/<date>/<slug>/  # archived completed ISAs
```

Defaults are baked in. YAML/TS files are optional — when missing, policies fall back to safe defaults.

### Disable the classifier

```bash
export CLAUDE_HOOKS_DISABLE_CLASSIFIER=1
```

When set, the dispatcher skips the Sonnet subprocess and returns deterministic ALGORITHM E3 fail-safe. Useful for CI runners without a `claude` CLI, perf benchmarks, and red-team runs.

---

## The Algorithm — what's the point?

The original PAI Algorithm makes a session a **verifiable transition from current state to ideal state.** Done is testable, not declared. The mode classifier picks the right cognitive depth so trivial prompts don't cost an Algorithm run AND substantial work doesn't get a one-shot answer. The ISA records the ideal state as ISCs (one binary tool probe each), the checkpoint records progress as git commits, the probes auto-verify what they can, and the Stop gate refuses to let the model claim "complete" without the receipts.

This package ports that primitive into a generic hook runtime so any Claude Code project gets it for free — no PAI install required. PAI users get the same primitive plus their full skill content.

---

## Debug

Tail the per-session ledger live:

```bash
claude-hooks-tail                        # follow every session under cwd
claude-hooks-tail --session <id>         # filter to one session
claude-hooks-tail --since 2026-01-01     # only events after timestamp
claude-hooks-tail --cwd /other/project   # tail another project's ledger
```

For traces, set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces` before launching Claude Code. Spans flow through the Effect tracer to your OTel collector. Without the env var, tracing is fully no-op (zero import cost).

Inspect classifier telemetry:

```bash
tail -f .claude-hooks/state/observability/mode-classifier.jsonl | jq .
```

---

## Contributing

```bash
bun install
bun run typecheck
bun test
bun run lint:claude-spawn       # CI guard: no direct `claude` spawns outside the chokepoint
```

Conventions:
- No `any`, no `// @ts-ignore`, no skipped tests.
- Side effects through services in `src/services/`.
- Policies as pure functions in `src/policies/`.
- All `claude` subprocesses MUST go through `src/services/claude-subprocess.ts` (env scrubbing). The CI guard refuses to build otherwise.
- Algorithm-aware code lives under `src/algorithm/`; per-PAI-source citations in code comments where applicable.

---

## License

MIT
