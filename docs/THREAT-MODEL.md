# Threat model & honest guarantees

**Status:** revised 2026-06-13 after an empirical adversarial review (PR #92, findings F1–F9 and N1–N9) that falsified the stronger "unforgeable" framing the SPEC used. This document states what the v2 hook system actually defends, what it does not, and why — so no one relies on a guarantee it does not provide.

## Substrate (the assumption that bounds everything)

The hooks execute as the **same OS user as the model** they gate, on a **local, single-user** machine, against **trusted code**. The model has shell access (Bash) and can read and write any file the user can. This is not incidental — it is the operating reality, and it is the ceiling on every claim below.

## What IS defended

A model **over-claiming by self-certification** — reporting work as done/verified without producing the evidence a gate requires. Concretely, the system makes the *cheap* dishonest paths fail:

- **Completion requires evidence, not assertion (§6.4).** An ISA at `phase: complete` is blocked unless every declared `## Criteria` ISC has a non-author evidence graph that is currently valid (survives a file-scope staleness recheck), or a host-confirmed manual flip. Saying "done" is not enough; zero declared criteria also blocks.
- **Verification runs real commands, pinned (§6.3).** Replay executes only allowlist- or brief-pinned argv, argv-only (no shell), cwd-confined, env-replaced, process-group-killed on timeout, and now refused outright if the pinned argv is destructive or runs interpreter-inline code.
- **Capability and safety are deterministic.** A briefed worker (or a recognized restrictive host type) is held to its role's tools; destructive commands and writes to secret/protected/generated paths are denied on every tool call, worker or orchestrator.
- **Trust artifacts live in a write-protected directory.** `.claude-hooks/` (except `briefs/`) is denied to Edit/Write and to the deterministic Bash write idioms (redirect incl. `>|`, `tee`, `cp`/`mv`, `dd`, `sed -i`/`perl -i`).

This is the **common** failure mode — a capable, non-adversarial model that is confident, hurried, or confused — and the system raises its cost materially. That is the honest value.

## What is NOT defended

A **deliberately adversarial** model. It runs as the user, so it can forge the trust substrate end-to-end:

- **It can read the HMAC secret (N4).** The per-session secret is stored `0600`, readable by the same user. `cat .claude-hooks/session-secret` is not blocked (and could not be without blocking the model from reading its own workspace). Once read, `verifyVerdict`/`verifyConfirmation` accept forgeries. So signing artifacts does not make them unforgeable here.
- **It can write protected files via an interpreter (N2/N3).** The Bash path-gate catches deterministic write idioms, but it cannot parse `python3 -c "open('.claude-hooks/evidence/<s>/<isc>.json','w').write(...)"`. A forged, well-shaped evidence graph passes the §6.4 completion gate (demonstrated live). The same defeats `isUserPinned` (forge `baseline.json`) and the manual-confirmation path (forge a confirmation).
- **Therefore the headline guarantees are scoped.** "The model cannot make its own claim count as trusted" and "dual & unforgeable verdict" (§6.5) hold against *accidental* over-claiming, **not** against forgery.

### Why this is fundamental, not a bug

In a same-user model there is **no on-disk secret the model cannot read and no file it cannot write**. An HMAC root only works if its key is outside the adversary's reach; here the adversary is the user. Closing it would require one of:

- a secret held outside the model's read-reach (a separate privilege domain / OS user / TPM-like store) — not available on this substrate;
- anchoring trust in an **external party** the model cannot impersonate (a remote service, a second human reviewer, signed CI);
- accepting the model is trusted and treating these gates as an **honesty scaffold**, which is the stance this document takes.

Chasing a forgery-proof root inside the same-user boundary is a losing game; naming the boundary is the honest move.

## Residual-finding ledger (this review round)

| # | Finding | Status |
|---|---------|--------|
| N1 | Capability gate failed **open** (threw on real host agent types → fail-open) | **Fixed** — role resolved from the brief; unknown host types never throw; capability binds only an explicit restrictive role; safety plane always on. |
| N2 | Trust artifacts are unauthenticated files the model can write | **Acknowledged substrate limit** — see above. Defense-in-depth raised (N3); not closed. |
| N3 | Write-gate bypasses (`>\|`, `sed -i`, `perl -i`) | **Hardened** (defense-in-depth). Interpreter-inline writes (`python -c`) remain unparseable by design — that is the N2 boundary. |
| N4 | HMAC secret is model-readable | **Acknowledged substrate limit** — an on-disk secret cannot be a forgery-proof root here. |
| N5 | Destructive patterns matched inert quoted text (over-block) | **Hardened** — patterns matched against a quote-masked command. Residual: heredoc bodies can still false-positive (documented). |
| N6 | Replay argv bypass via `env <interp>` / versioned interpreter | **Hardened** — env-unwrapped, versioned interpreter names covered. |
| N7 | Same-role concurrent spawns can cross-bind (FIFO within a role) | **Documented host limit** — no id is threaded from spawn → SubagentStart; fails closed rather than mis-bind. |
| N8 | No committed `policy.json` ⇒ the replay-flip path is inert in practice | **Documented** — completion via replay needs a user-committed allowlist; otherwise only manual+confirmation flips. |
| N9 | `accepted_verified` outcome name reused for no-replay outcomes | **Mitigated** — trust label and advice now key on actual replay; outcome-name rename deferred. |

## One-line summary

This is an **honesty scaffold for a trusted model**, not a verification wall against an adversarial one. It makes lying expensive and accidental over-claiming hard; it does not make forgery impossible, and on a same-user machine it cannot.
