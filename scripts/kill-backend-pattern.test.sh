#!/usr/bin/env bash
#
# Regression guard for EVO-1609.
#
# The `kill-backend` npm script runs `pkill -f '<ERE>'`. Because `pkill -f` is
# unanchored over each process's FULL command line, a sloppy ERE matches the very
# shell that invokes pkill (the literal pattern text sits in that shell's argv) and
# self-terminates `dev:single` before it can boot.
#
# This test extracts the ERE straight from package.json and asserts, with grep (no
# processes are killed), that it:
#   * matches the real backend process signatures (prod + dev-watch), and
#   * does NOT match its own `kill-backend` command line  -> the deterministic,
#     cross-platform proxy for "it will not kill its own parent shell".
#
# Run locally:  npm run test:kill-backend     (or: bash scripts/kill-backend-pattern.test.sh)

set -u
cd "$(dirname "$0")/.."

KILL_CMD="$(node -e "process.stdout.write(require('./package.json').scripts['kill-backend'])")"
PATTERN="$(printf '%s' "$KILL_CMD" | sed -E "s/.*-f '([^']*)'.*/\1/")"

if [ -z "$PATTERN" ] || [ "$PATTERN" = "$KILL_CMD" ]; then
  echo "FAIL: could not extract the -f '<ERE>' pattern from kill-backend script value:"
  echo "      $KILL_CMD"
  exit 1
fi

echo "kill-backend script : $KILL_CMD"
echo "extracted ERE       : $PATTERN"
echo

FAIL=0
assert_match()   { if printf '%s' "$2" | grep -Eq "$PATTERN"; then echo "ok   match    : $1"; else echo "FAIL want match : $1 -> '$2'"; FAIL=1; fi; }
assert_nomatch() { if printf '%s' "$2" | grep -Eq "$PATTERN"; then echo "FAIL want NO match: $1 -> '$2'"; FAIL=1; else echo "ok   no-match : $1"; fi; }

# --- must match: the real backend process signatures (evo-flow emits dist/main.js;
#     tsc strips the src/ root since every input lives under src/) ---
assert_match "start:prod"            "node dist/main"
assert_match "docker CMD"            "node dist/main.js"
assert_match "dumb-init wrapper"     "dumb-init -- node dist/main.js"
assert_match "nest start --watch"    "node --enable-source-maps dist/main.js"
assert_match "with RUN_MODE + args"  "RUN_MODE=single node dist/main.js --foo"
# defensive: the (src/)? branch also covers a dist/src/main.js layout (sibling
# evo-campaign scaffold / a future monorepo build) so the script stays portable.
assert_match "alt dist/src/ layout"  "node --enable-source-maps dist/src/main.js"

# --- must NOT match: lookalikes (no false positives) ---
assert_nomatch "maintenance script"  "node dist/maintenance.js"
assert_nomatch "main-old artifact"   "node dist/main-old.js"

# --- must NOT match: its own command line (the self-kill guard for EVO-1609) ---
assert_nomatch "self (kill-backend cmd)" "$KILL_CMD"
assert_nomatch "self (sh -c wrapper)"    "sh -c $KILL_CMD"

echo
if [ "$FAIL" -ne 0 ]; then
  echo "RESULT: FAILED — kill-backend pattern regressed (see EVO-1609)."
  exit 1
fi
echo "RESULT: PASS"
