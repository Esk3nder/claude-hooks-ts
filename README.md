# claude-hooks-ts

A type-safe, Effect-based dispatcher for [Claude Code](https://docs.claude.com/claude-code) hooks.
Replaces ad-hoc per-hook shell scripts with a single TypeScript binary that decodes hook payloads
through `effect/Schema`, runs them through declarative policies, and emits the structured JSON
Claude Code expects. Built around a deterministic event-driven control plane: safety, quality,
token efficiency, CI-style verification, research workflows.

## Quick install

```bash
bun add -g github:Esk3nder/claude-hooks-ts
claude-hooks-install --dry-run                        # preview the merge
claude-hooks-install --apply                          # write atomically with backup
claude-hooks-install --uninstall --apply              # cleanly remove our entries
```

The installer merges 16 hook entries into `~/.claude/settings.json` (or any `--target` path),
preserving existing unrelated hooks and other settings keys. Existing entries that point at our
dispatcher are replaced idempotently; the prior file is backed up to `<target>.bak.<timestamp>`
before any write.

## Hook coverage

| Event | Handler | Behaviour |
|---|---|---|
| `SessionStart` | `session-start-brief` | Inject branch, dirty files, verify commands. |
| `UserPromptSubmit` | `prompt-router` | Classify into 15 workflow tags; persist `last_workflow`. |
| `PreToolUse` | `pretool-policy` | Deny secrets/destructive; ask lockfiles/settings; rewrite test commands to failure-only output. |
| `PostToolUse` (Edit\|Write\|MultiEdit) | `post-edit-quality` | Targeted formatter/lint per file type. |
| `PostToolBatch` | `batch-context-governor` | Persist ledger; extract URLs from `WebFetch`/`WebSearch`; inject compact summary. |
| `PostToolUseFailure` | `failure-explainer` | Parse error → next-action hint. |
| `Stop` | `stop-definition-of-done` | Block if files changed without verification, or if research workflow lacks source ledger. |
| `PreCompact` | `precompact-snapshot` | Preserve goal, plan, files changed, sources to disk. |
| `SessionEnd` | `session-ledger` | Append-only audit trace. |
| `PermissionRequest` | `permission-autopilot` | Auto-approve safe repeats. |
| `ConfigChange` | `config-guard` | Detect weakened permissions/hooks. |
| `FileChanged` | `filechanged-env-guard` | Watch `.env`, lockfiles, manifests. |
| `SubagentStart`/`Stop` | `subagent-scope-gate` | Enforce read-only scope + evidence requirement. |
| `TaskCreated`/`Completed` | `task-integrity` | Acceptance criteria + evidence. |

## Configuration

Project-level YAML lives under `.claude-hooks/`:

```
.claude-hooks/
  protected-paths.yaml      # paths that cannot be edited without ask
  generated-files.yaml      # paths that cannot be edited at all
  test-map.yaml             # mapping from changed file -> smallest verify command
  research-domains.yaml     # whitelisted research source roots
  state/                    # per-session ledgers (managed by hooks)
  state/compact-snapshots/  # PreCompact preservation snapshots
```

Defaults are baked in; override only what you need. Policies fall back to safe defaults when YAML
is missing.

## Troubleshooting

- **Cold-start latency.** A Bun-spawned dispatcher invocation has a `p50 ~ 130-160ms` on a warm
  filesystem; the first invocation after `bun install` may spike to 300ms. The benchmark in
  `test/perf/cold-start.test.ts` enforces a 300ms p50 budget locally and 350ms in CI (chosen to absorb spawn jitter when run in parallel with the full suite; the median in isolation sits near 140ms). The
  original design budget of <100ms proved unrealistic - Bun startup alone is ~120ms - so we
  measure against a more honest bound.
- **Bun fallback.** If `bun` is not on `PATH`, the `bin/claude-hook` shim fails; install Bun
  first (`curl -fsSL https://bun.sh/install | bash`). A `tsx`-based fallback is on the roadmap.
- **Settings backup location.** The installer always copies the existing settings.json to
  `<target>.bak.<ISO-timestamp>` before writing.

## Development

```bash
bun install
bun test                                    # 291 tests
bun run typecheck                           # tsc --noEmit
bun test test/redteam/                      # full red-team suite (10/10)
bun test test/perf/cold-start.test.ts       # cold-start budget
```

Pull requests welcome. Please keep:

- No `any`, no `// @ts-ignore`, no skipped tests.
- All hooks pure-Effect; side effects through services in `src/services/`.
- Policies pure functions in `src/policies/`.

## License

MIT (c) 2026 Esk3nder

## Debugging — `claude-hooks-tail`

Stream the per-session ledger like `tail -f`:

```bash
# Follow every session's ledger under the current cwd
bun run scripts/tail.ts

# Or via the bin shim once installed
claude-hooks-tail

# Filter to one session
claude-hooks-tail --session abc123

# Only events from a given ISO time
claude-hooks-tail --since 2026-05-02T00:00:00Z

# Run against a different project
claude-hooks-tail --cwd /path/to/repo
```

Reads `<cwd>/.claude-hooks/state/<session>/ledger.jsonl` (or globs every
`ledger.jsonl` under the state dir when `--session` is omitted), tails new
appends every 200ms, and pretty-prints each entry as
`[<iso>] <event> <session-short>: <summary>`. ANSI color when stdout is a TTY.
SIGINT exits cleanly.
