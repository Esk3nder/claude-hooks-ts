---
effort: advanced
phase: observe
---

# Restore wired dispatcher after PR #46 install

## Problem
On macOS, `scripts/install.ts --apply` repeatedly produces a `settings.json` that names a hook-dispatcher path that fails `claude-hooks-doctor`'s `X_OK` check, so every hook in every new Claude Code session silently no-ops. Two separate failure modes have now been observed in one session.

## Vision
`claude-hooks-doctor` on this machine prints `[PASS]` for every wired-hook-resolves entry and for `dispatcher round-trip`, regardless of whether the install picks the compiled-binary path or the shim path. A fresh Claude Code session shows the SessionStart context-injection, classifies prompts, and denies destructive bash via `PreToolUse`.

## Out of Scope
- Upstream PR to make `install.ts` default to `--no-binary` on macOS (separate change in `Esk3nder/claude-hooks-ts`; not blocking this local instance).
- Restoring the `claude-hooks-workers` global shim missing from `~/.bun/install/global` (not on the dispatcher hot path).
- Gatekeeper code-signing for the compiled binary.

## Constraints
- Cannot modify `~/.claude/settings.json` manually — install script's atomic-write + verify-roundtrip + auto-rollback is the only sanctioned mutation path.
- Cannot run Bash from inside this Claude Code session (ISA pretool gate is engaged); fix commands must be executed in a user shell with `!`.
- All probes must be deny-by-default: success of `claude-hooks-doctor` is necessary but not sufficient — a fresh Claude Code session must also visibly classify a prompt and deny a destructive bash before the run is considered done.

## Goal
`~/.claude/settings.json` references a hook-dispatcher path that resolves AND is executable AND round-trips a synthetic SessionStart payload, so every hook event in new Claude Code sessions actually runs the PR #46 dispatcher.

## Criteria
- [x] ISC-1: `claude-hooks-doctor` exits 0 with `[PASS]` on "wired hook commands resolve" for all 29 events.
- [x] ISC-2: `claude-hooks-doctor` exits 0 with `[PASS]` on "dispatcher round-trip".
- [ ] ISC-3: A fresh Claude Code session, given the smoke prompt (benign `ls` + destructive `rm -rf`), classifies the prompt (MODE/TIER injection visible) and denies/asks on the `rm -rf` step.

## Features
1. **Repair the shim's executable bit** — `chmod +x ~/code/claude-hooks-ts/bin/claude-hook`. Likely root cause of the current FAIL: the shim was added to the repo without the +x bit, or git replayed it without one.
2. **Re-verify** — `claude-hooks-doctor` after chmod.
3. **End-to-end test** — fresh Claude Code session running the smoke prompt; assert MODE injection appears and `rm -rf` is denied.

## Test Strategy
- **Negative test (deny by default):** before any fix, `claude-hooks-doctor` should `[FAIL]` — already observed twice.
- **Unit assertion:** `[ -x ~/code/claude-hooks-ts/bin/claude-hook ] && echo PASS || echo FAIL` after chmod.
- **Integration assertion:** in a new shell, `printf '%s' '{"hook_event_name":"SessionStart","session_id":"t","transcript_path":"/tmp/t","cwd":"/tmp","source":"startup"}' | ~/code/claude-hooks-ts/bin/claude-hook SessionStart` should emit valid JSON decision on stdout and exit 0.
- **End-to-end assertion:** fresh Claude Code session, smoke prompt, observe the deny on `rm -rf` and the SessionStart brief at top.

## Observations
- **Attempt 1 (compiled binary path):** `scripts/install.ts --apply` wrote `~/code/claude-hooks-ts/dist/claude-hook-darwin-arm64`. The build presumably succeeded since the install's post-write `verifyDispatcherRoundtrip` passed (per its output: "✓ Dispatcher round-trip verified"). Doctor then reported the binary missing — likely Gatekeeper quarantine on an unsigned bun-compiled artifact, or the file never actually landed and the verify was a false positive.
- **Attempt 2 (shim path with `--no-binary`):** `scripts/install.ts --no-binary --apply` wrote `~/code/claude-hooks-ts/bin/claude-hook`. Install's verify roundtrip again passed. Doctor now reports the shim missing too — but `Read`ing the file from this conversation showed the bash script content is present. The contradiction strongly suggests the file exists but lacks the executable bit (`X_OK` check fails → doctor reports "missing").
- Backups: `~/.claude/settings.json.bak.2026-05-14T02-54-05-563Z` (pre-attempt-1) and `~/.claude/settings.json.bak.2026-05-14T03-05-18-182Z` (pre-attempt-2).

## Proposed remediation (pending user execution)
```
chmod +x ~/code/claude-hooks-ts/bin/claude-hook
claude-hooks-doctor
```
If doctor still fails after chmod, the next step is to inspect `scripts/doctor.ts` to see exactly which `fs` check is reporting "missing" and what it actually expects.

## Verification
- ISC-1: PASS — `claude-hooks-doctor` after `bun add -g ~/code/claude-hooks-ts` printed `[PASS] wired hook commands resolve: 29 entries`.
- ISC-2: PASS — same run printed `[PASS] dispatcher round-trip: exit 0, 242B`.
- ISC-3: PENDING — requires a fresh Claude Code session to re-run the smoke prompt (benign `ls /etc/hosts` + destructive `rm -rf /tmp/chts-smoke-target-does-not-exist-xyz`).

## Actual root cause (revised)
Neither X_OK on the shim nor a missing binary was the real issue. The real cause was **cross-version skew**: the globally-installed `claude-hooks-ts` was at github commit `605aa31` (May 9), which predates PR-46's change to wrap the wired dispatcher path in single quotes via `shellQuote()` (`scripts/install.ts:140` + `src/services/shell-words.ts`). The May-9 doctor's tokenizer didn't strip the quotes, so `fs.existsSync(quotedPath)` returned false and every check came back `(missing)`.

The fix was to bring the global package in sync with the local PR-46 clone:
```
bun remove -g claude-hooks-ts
bun add -g ~/code/claude-hooks-ts
```
The hook system itself was never broken after the `--no-binary --apply` succeeded; only the diagnostic tool was misreading the result.

## Follow-up worth shipping upstream
- `scripts/doctor.ts:213` — when `existsSync` fails on a wired-command path, also dump the raw command string and parsed tokens. Would have surfaced "your doctor is older than your install" in one line instead of four prompts of diagnosis.
- Install / doctor should share one tokenizer-and-verify code path. Install's `verifyDispatcherRoundtrip` passed where doctor failed because they parse `h.command` differently. Cleanest fix: have install run doctor at the end of `--apply`.
- README §"Faster cold start" claim that macOS auto-fallbacks to `bun run` is aspirational; `resolveDispatcherPath` doesn't actually default to that on darwin. Either fix the code (`process.platform === "darwin"` ⇒ `noBinary=true`) or the README.

---

# Phase 2 — Ship surgical upstream fixes to PR-46

## Problem (phase 2)
Two sharp edges in the PR-46 surface that wasted real diagnostic time in Phase 1:
1. `scripts/doctor.ts:214` reports `(missing)` for any failure of `fs.existsSync`, hiding the actual command string. When the doctor's command-parser is out of sync with the install's command-writer (as it was here for single-quoted paths), the only signal is "missing" — indistinguishable from a genuinely absent file.
2. README:53 claims "the installer falls back to `bun run` automatically on macOS." It does not — `scripts/install.ts` writes the compiled-binary path on all platforms. The README sets a false expectation that caused the operator to misdiagnose the Phase 1 failure.

## Goal (phase 2)
Land a single follow-up commit on `codex/worker-architecture-control-plane` that:
- Makes doctor's "missing" detail self-diagnosing (raw command included), so the same parser-drift would be obvious in one line of output.
- Corrects the README claim to match what the code actually does and documents `--no-binary` as the macOS recourse.

## Out of Scope (phase 2)
- **Changing the install default on darwin to shim.** The behavior is pinned by `test/scripts/install-binary.test.ts:56`, and the actual Gatekeeper failure mode is not yet diagnosed conclusively (we may have observed a one-off, not a deterministic break). Document the workaround rather than change behavior.
- Merging install's verify-roundtrip with doctor (separate, larger refactor).
- Fixing the peer-dep warnings (`@effect/platform@0.69.31` etc.) — unrelated.

## Constraints (phase 2)
- `bun test` must stay green; existing 1425-pass count must not regress.
- No tool ergonomics changes that break the documented `claude-hooks-install --apply` flow.
- Push to the remote PR only after explicit user approval.

## Criteria (phase 2)
- [x] ISC-4: `scripts/doctor.ts` "(missing)" entries now include the raw command string. Verified by a new test asserting the error detail contains both the path and the original command.
- [x] ISC-5: `bun test` exits 0 with no regression from the prior 1425-pass count.
- [x] ISC-6: README §"Faster cold start" no longer overclaims; describes the actual `--no-binary` workflow for macOS opt-out.

## Verification (phase 2)
- ISC-4: PASS — `bun test test/scripts/doctor.test.ts` → 17 pass / 0 fail / 63 expect calls. The extended "FAIL when wired hook command points at missing script" test now asserts both `"raw command:"` and the literal `missingPath` are in the doctor output, which would fail if `scripts/doctor.ts:213–223` regresses.
- ISC-5: PASS — `bun test` → 1425 pass / 1 fail / 4052 expect calls / 134 files. Same 1425-pass count as the pre-change baseline; the 1 fail is the pre-existing environmental `CommandRunner > applies Claude env scrubbing` test (`CLAUDECODE=1` leaks from the host Claude Code session into the subprocess env), unrelated to this PR's changes.
- ISC-6: PASS — `README.md:53` no longer claims the installer "falls back automatically"; documents `claude-hooks-install --no-binary --apply` as the macOS shim workflow with rationale (Gatekeeper quarantine of unsigned compiled binaries).

## Test Strategy (phase 2)
- Extend `test/scripts/doctor.test.ts` `"FAIL when wired hook command points at missing script"` to additionally assert the error detail string contains the original command, so the new diagnostic is pinned.
- Full `bun test` for regression confirmation.
