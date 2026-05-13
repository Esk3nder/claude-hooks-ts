#!/usr/bin/env bun
import { currentProcessEnv } from "../src/bootstrap/env.ts"
/**
 * Postinstall — INTENTIONALLY MINIMAL.
 *
 * Per the original architectural plan (B3 decision), this script does NOT
 * touch `~/.claude/skills/`, does NOT modify `settings.json`, and does NOT
 * spawn any subprocess. Anything that mutates user state is opt-in via
 * `claude-hooks-init` (per project) or `claude-hooks-install --apply`
 * (per settings file).
 *
 * The only thing this prints is a one-line install hint. That's it.
 */

const QUIET = currentProcessEnv()["CLAUDE_HOOKS_QUIET_POSTINSTALL"] === "1"
if (!QUIET) {
  process.stdout.write(
    "claude-hooks-ts installed. Next steps:\n" +
      "  claude-hooks-install --apply         # wire dispatcher into ~/.claude/settings.json\n" +
      "  claude-hooks-init                    # create per-project state dir\n" +
      "  claude-hooks-init --install-skills   # install bundled SKILL.md stubs (opt-in)\n" +
      "  claude-hooks-doctor                  # verify wiring + algorithm setup\n",
  )
}
