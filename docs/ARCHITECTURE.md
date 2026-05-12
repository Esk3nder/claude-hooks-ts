# Architecture

`claude-hooks-ts` is a Claude Code hook runtime, not a single hook script. It
decodes external hook payloads, routes every event, enforces local safety
policies, records session state, runs bounded subprocesses, and keeps the hook
process fail-safe under latency pressure.

This document defines the intended boundaries so future changes do not turn the
repo into either a tiny-script abstraction pile or an untestable side-effect
blob.

## Why Effect is here

Effect earns its complexity at runtime boundaries:

- **External protocol boundary** — hook payloads are untrusted JSON. Decode them
  with `Schema` before routing.
- **Handler orchestration** — event handlers compose state reads/writes,
  subprocesses, timeouts, fallbacks, and telemetry.
- **Dependency injection** — filesystem, shell, git, subprocess, state, ledger,
  telemetry, and redaction capabilities must be replaceable in tests.
- **Latency control** — dispatcher-level per-event timeouts keep hooks from
  hanging Claude Code.
- **Best-effort side effects** — ledgers, telemetry, and cleanup should not
  compromise the hook response.

Effect is not the point of the project. It is the boundary tool for code that
talks to the world.

## Where Effect should not spread

Keep deterministic domain logic plain TypeScript:

- policy reducers under `src/policies/`
- schema-independent path/key normalization helpers
- ISA parsing/completeness checks when they only transform strings
- command-selection logic such as verify-map matching

Pure functions are easier to test, review, and reuse than small Effect programs.
Use Effect when a function needs services, timeouts, spans, retries/fallbacks, or
explicit failure handling.

## Current layers

```txt
src/schema/       external payload and decision contracts
src/dispatcher.ts stdin/stdout adapter, decode, route, timeout, emit
src/events/       per-hook use cases; orchestration only
src/policies/     pure decision logic and matchers
src/services/     side-effect ports plus live/test implementations
src/algorithm/    ISA/classifier/checkpoint/probe domain
src/layers/       runtime service composition
scripts/          install/build/doctor/guard CLIs
```

## Boundary rules

### `schema/`

- Owns wire compatibility and internal decoded shapes.
- Adding an event means updating the canonical event list and payload union
  together.
- Do not put policy decisions here.

### `dispatcher.ts`

- Is the only normal stdin/stdout hook adapter.
- Decodes once, dispatches by exhaustive tag match, applies per-event timeout,
  emits exactly one hook decision, then performs best-effort post-emit work.
- Top-level malformed `PreToolUse` input must fail closed to `ask`; other
  malformed events may use `{}` when blocking would risk trapping the session.

### `events/`

- Are thin application use cases: read state, call policy/domain code, invoke
  services, return a hook decision.
- Should preserve ordering and budget comments when multiple gates interact.
- Should not accumulate new parsing or matching rules if those rules can live in
  `policies/` or `algorithm/`.

### `policies/`

- Prefer plain functions with explicit inputs and outputs.
- No filesystem, subprocess, clock, env, stdout, or stderr side effects.
- If a policy needs current project facts, pass those facts in from the handler
  or a service.

### `services/`

- Own effects that touch the host: filesystem, shell, git, child processes,
  session state, ledgers, telemetry, redaction, and project discovery.
- Every live service should have a test substitute or be easy to stub.
- Preserve body errors when wrapping locks/timeouts; do not convert all failures
  into generic filesystem failures.

### `algorithm/`

- Owns product-level behavior: classifier, ISA lifecycle, criteria, probes,
  checkpointing, and built-in reasoning helpers.
- Prefer pure parsing/checking helpers first.
- Side-effectful algorithm operations are acceptable only when they are cohesive
  domain operations; if they become general filesystem/shell utilities, move
  them behind services.

## Failure and fallback doctrine

Hooks should be conservative without trapping the user:

| Area | Preferred failure behavior |
| --- | --- |
| `PreToolUse` safety gate | `ask` or `deny` when input shape is unknown |
| malformed non-tool events | `{}` unless the event has a safe event-specific fallback |
| classifier failure | conservative Algorithm classification |
| Stop completeness/verification failure | `block` when state is trustworthy |
| telemetry / ledger / cleanup failure | log if useful, then no-op |
| formatter / probe best-effort failure | log bounded detail, then continue |

Never silently allow a tool because a write/read/bash payload shape drifted.

## Adding new behavior

1. Put pure matching/decision rules in `src/policies/` or pure
   `src/algorithm/` helpers.
2. Keep the event handler as orchestration glue.
3. Add or reuse a service for host side effects.
4. Add tests at the lowest useful layer:
   - pure unit tests for policies,
   - handler tests for gate ordering and hook decisions,
   - dispatcher tests for protocol decode/fallback behavior.
5. Run at least `bun run typecheck` and the relevant targeted tests; use the
   full suite for cross-cutting changes.

## Known migration direction

The repo already has service boundaries for most critical effects. Some legacy
or domain-specific paths still use direct Node APIs inside event/algorithm
modules. Do not perform a broad abstraction-only rewrite. Instead, move raw
side effects behind services when a concrete bug, testability gap, or repeated
pattern justifies it.
