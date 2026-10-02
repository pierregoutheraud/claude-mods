#!/usr/bin/env bash
# Validates the marketplace and every plugin in it, then runs each plugin's tests.
# Type-checks a plugin too when Claude Code has loaded it once (its types are laid then).
set -euo pipefail
cd "$(dirname "$0")/.."

claude plugin validate .

for plugin in plugins/*/; do
  plugin="${plugin%/}"
  echo "== $plugin"
  claude plugin validate "$plugin"
  claude plugin test "$plugin"
  if [ -d "$plugin/.claude-plugin/types" ] && command -v tsc >/dev/null; then
    tsc -p "$plugin"
  fi
done
