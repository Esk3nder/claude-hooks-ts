#!/usr/bin/env bash
#
# confirm-methodology.sh — one-shot end-to-end gate for the methodology system.
#
# Exits 0 only when ALL of the following pass:
#   1. `bun run typecheck`
#   2. `bun test test/integration/methodology/`
#   3. The methodology fixture suite contains at least MIN_FIXTURE_TESTS tests
#      (we ship 19; the floor is 17 so a small intentional removal doesn't
#      silently regress the gate).
#
# A green run prints "✓ Methodology enforced end-to-end" on the last line.
#
# Usage:
#   bash scripts/confirm-methodology.sh         # run all gates
#   bash scripts/confirm-methodology.sh --help  # print this usage and exit 0
#
# Env:
#   CONFIRM_METHODOLOGY_DRY_RUN=1   skip heavy steps (typecheck + tests),
#                                   still print the green summary. Used by
#                                   the smoke test in test/scripts/.

set -euo pipefail

MIN_FIXTURE_TESTS=17
METHODOLOGY_DIR="test/integration/methodology"
GREEN_LINE="✓ Methodology enforced end-to-end"

usage() {
  sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'
}

# --- arg parsing ---------------------------------------------------------
case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  "")
    : # no args, proceed
    ;;
  *)
    printf 'confirm-methodology: unknown argument: %s\n' "$1" >&2
    printf 'Try: bash scripts/confirm-methodology.sh --help\n' >&2
    exit 2
    ;;
esac

# --- locate repo root ----------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# --- dry-run short-circuit (used by smoke test) --------------------------
if [ "${CONFIRM_METHODOLOGY_DRY_RUN:-0}" = "1" ]; then
  printf '[dry-run] skipping typecheck + integration suite + fixture count\n'
  printf '%s\n' "$GREEN_LINE"
  exit 0
fi

fail() {
  printf '\nconfirm-methodology FAILED at gate: %s\n' "$1" >&2
  exit 1
}

# --- gate 1: typecheck ---------------------------------------------------
printf '[1/3] bun run typecheck ... '
if bun run typecheck >/tmp/confirm-methodology-typecheck.log 2>&1; then
  printf 'ok\n'
else
  printf 'FAILED\n' >&2
  printf '  log: /tmp/confirm-methodology-typecheck.log\n' >&2
  tail -20 /tmp/confirm-methodology-typecheck.log >&2 || true
  fail "typecheck"
fi

# --- gate 2: methodology integration suite -------------------------------
printf '[2/3] bun test %s ... ' "$METHODOLOGY_DIR"
TEST_LOG=/tmp/confirm-methodology-tests.log
if bun test "$METHODOLOGY_DIR" >"$TEST_LOG" 2>&1; then
  printf 'ok\n'
else
  printf 'FAILED\n' >&2
  printf '  log: %s\n' "$TEST_LOG" >&2
  tail -40 "$TEST_LOG" >&2 || true
  fail "methodology integration suite"
fi

# --- gate 3: fixture count >= floor --------------------------------------
# Bun's `bun test` summary line looks like:
#   "Ran 19 tests across 7 files. [166.00ms]"
# We parse it with grep + awk only — no jq, no node.
SUMMARY_LINE="$(grep -E '^Ran [0-9]+ tests across [0-9]+ files\.' "$TEST_LOG" | tail -1 || true)"
if [ -z "$SUMMARY_LINE" ]; then
  printf '[3/3] fixture count ... FAILED (no summary line in test output)\n' >&2
  fail "fixture count parse"
fi
TEST_COUNT="$(printf '%s\n' "$SUMMARY_LINE" | awk '{print $2}')"
case "$TEST_COUNT" in
  ''|*[!0-9]*)
    printf '[3/3] fixture count ... FAILED (non-numeric: %s)\n' "$TEST_COUNT" >&2
    fail "fixture count parse"
    ;;
esac

printf '[3/3] fixture count = %s (floor %s) ... ' "$TEST_COUNT" "$MIN_FIXTURE_TESTS"
if [ "$TEST_COUNT" -lt "$MIN_FIXTURE_TESTS" ]; then
  printf 'FAILED\n' >&2
  printf '  too few methodology fixture tests: %s < %s\n' \
    "$TEST_COUNT" "$MIN_FIXTURE_TESTS" >&2
  fail "fixture count floor"
fi
printf 'ok\n'

# --- green --------------------------------------------------------------
printf '%s\n' "$GREEN_LINE"
exit 0
