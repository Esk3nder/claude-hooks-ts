# claude-hooks-ts

**A type-safe dispatcher that turns Claude Code's 29 hook events into one verifiable control plane** — schemas, policies, and gates instead of ad-hoc shell scripts. One binary decodes every hook payload through a strict schema, runs it through declarative policies, and emits the exact JSON Claude Code expects. Includes a mode classifier, an ISA-driven completeness gate, an engagement gate that requires a written spec before non-trivial work, and an auto-checkpoint that commits when verification probes pass.

If you're running Claude Code in any context where "looks done" isn't good enough — production code, regulated work, anything you'd hate to debug later — this gives you receipts.

---

## Why this exists

Claude Code fires a hook for every meaningful step in a session: `PreToolUse`, `Stop`, `PostToolUse`, `UserPromptSubmit`, `CwdChanged`, 24 more. Each hook is a chance to inject context, deny something dangerous, rewrite a tool input, or block a premature `Stop`. The default way to wire those up is per-event shell scripts. That falls over fast:

- No shared state between handlers, so you can't say "block Stop because the run produced no verifiable artifact."
- No schema for payloads, so you write defensive parsers in every script.
- No way to know whether a session was a 30-second one-shot or a 2-hour algorithmic effort — they get the same gates.

This package replaces that with one Bun binary. It decodes payloads against a strict Effect Schema, routes through 29 typed handlers (exhaustiveness enforced at compile time), and writes a session ledger so what happened is reconstructible after the fact.

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

- **`PreToolUse`** — denies edits to `protected-paths.yaml` entries, refuses writes to `generated-files.yaml`, blocks destructive shell patterns, gates ISA-required sessions to writing the spec first.
- **`PreToolUse` + `SubagentStart` / `SubagentStop`** — turns marked `Task` / `Agent` launches into bounded workers by injecting scope/output contracts and requiring structured, evidenced output while leaving bare subagents alone; killed workers with no output are cancelled instead of leaving the parent locked.
- **`UserPromptSubmit`** — classifies the prompt's cognitive mode (MINIMAL / NATIVE / ALGORITHM with tier E1–E5), records the classification, and injects it as `additionalContext` so the model enters the right depth. Conservative fail-safe to ALGORITHM E3 on any error.
- **`PostToolUse`** — runs your `.claude-hooks/probes.ts` (hot-loaded) against the active ISA; on pass, flips `[ ]` to `[x]` and auto-commits.
- **`Stop`** — blocks when the active ISA is `phase: complete` but tier-required sections are missing or ISCs are unchecked. Runs declarative regenerate rules when source files changed.
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

## License

See [`LICENSE`](./LICENSE).
