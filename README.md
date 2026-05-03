# claude-hooks-ts

A type-safe, Effect-based dispatcher for [Claude Code](https://docs.claude.com/claude-code) hooks. Replaces ad-hoc per-hook shell scripts with a single TypeScript binary that decodes hook payloads, runs them through declarative policies, and emits the structured JSON Claude Code expects.

> **WIP — under construction.** This repository is in active scaffolding (M0). Hook handlers, schemas, services, and policies land in subsequent milestones.

## Status

- [x] M0: Repository scaffold, Bun + Effect toolchain, CI green
- [ ] M1: Event schemas + dispatcher routing
- [ ] M2: Services (filesystem, process, config)
- [ ] M3: Policy engine
- [ ] M4: Hook handlers
- [ ] M5: Installer + docs

## Design

See the architecture overview (forthcoming) for the full design. In short: each Claude Code hook event is parsed via `@effect/schema`, routed by event name, and handled by an Effect program that produces a `HookDecision` rendered to stdout.

## License

MIT (c) 2026 Esk3nder
