# claude-hooks-ts

A type-safe dispatcher for [Claude Code](https://docs.claude.com/claude-code) hooks.

Replaces ad-hoc per-hook shell scripts with a single binary that decodes hook payloads through a strict schema, runs them through declarative policies, and emits the structured JSON Claude Code expects. One control plane for safety, quality, token efficiency, verification gates, and audit.

---

## What it does

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

Every decision is recorded to a per-session JSONL ledger. Optional OpenTelemetry export for spans. Cross-process file locks so parallel Claude Code sessions can't corrupt state.

See [`docs/HOOK-EVENTS.md`](./docs/HOOK-EVENTS.md) for the full per-event reference (input/output schemas, behavior, quirks).

---

## Install

Requires [Bun](https://bun.sh).

```bash
bun add -g github:Esk3nder/claude-hooks-ts
claude-hooks-install --dry-run                  # preview the merge first
claude-hooks-install --apply                    # write atomically with .bak backup
```

The installer merges hook entries into `~/.claude/settings.json` (or `--target <path>`), preserving unrelated keys. The previous file is backed up to `<target>.bak.<ISO-timestamp>` before any write. Install is idempotent — re-running replaces only our entries.

To uninstall:
```bash
claude-hooks-install --uninstall --apply
```

### Faster cold start (Linux)

By default, hooks run via `bun run`. On Linux you can compile to a single binary instead — cuts dispatcher cold-start by ~3x, paid on every tool call:

```bash
bun run build:bin                      # produces dist/claude-hook-<platform>-<arch>
claude-hooks-install --apply           # auto-detects the binary, wires it directly
```

Force the bun-run path with `--no-binary`. macOS automatically falls back since unsigned compiled binaries are killed by Gatekeeper without a paid Apple Developer ID.

---

## Verify it works

```bash
claude-hooks-doctor
```

End-to-end checks: bun on PATH, settings.json parseable, every wired hook command resolves and is executable, state dir writable, dispatcher round-trip succeeds. Exits non-zero on any problem. Use `--verbose` for details, `--json` for machine output.

---

## Configure

Project-local config lives at `<project>/.claude-hooks/`:

```
.claude-hooks/
  protected-paths.yaml      # paths requiring confirmation before edit
  generated-files.yaml      # paths that cannot be edited
  test-map.yaml             # changed-file → smallest verify command
  research-domains.yaml     # whitelisted research source roots
  state/                    # per-session ledgers (managed by hooks)
```

Defaults are baked in. YAML files are optional — when missing, policies fall back to safe defaults. Override only what you need.

---

## Debug

Tail the per-session ledger live:

```bash
claude-hooks-tail                        # follow every session under cwd
claude-hooks-tail --session <id>         # filter to one session
claude-hooks-tail --since 2026-01-01     # only events after timestamp
claude-hooks-tail --cwd /other/project   # tail another project's ledger
```

Output: `[<iso>] <event> <session>: <summary>`. ANSI colors on a TTY. SIGINT exits cleanly.

For traces, set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces` before launching Claude Code. Spans flow through the Effect tracer to your OTel collector. Without the env var, tracing is fully no-op (zero import cost).

---

## Contributing

```bash
bun install
bun run typecheck
bun test
```

Conventions:
- No `any`, no `// @ts-ignore`, no skipped tests.
- Side effects through services in `src/services/`.
- Policies as pure functions in `src/policies/`.

---

## License

MIT
