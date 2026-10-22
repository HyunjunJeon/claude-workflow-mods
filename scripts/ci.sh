#!/usr/bin/env bash
# Runs every check of this repository in order and stops at the first one that fails, with that step's exit code.
# Usage: bash scripts/ci.sh   (from any directory; it changes to the repository root first)
# Two steps may be skipped, and a skip is printed, never silent:
#   semgrep: skipped when it is not installed, but a failure when CI=true, so a CI run cannot pass without the rule tests.
#   tsc:     skipped when .claude-plugin/types/ is missing (Claude Code writes it when it loads the plugin), in CI as well.
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

step() {
  printf '== %s\n' "$1"
}

step 'claude --version'
claude --version

step 'claude plugin validate'
claude plugin validate .

step 'claude plugin test'
claude plugin test .

step 'flow definitions'
bun eval/check-definition.ts --allow-warnings flows/improvement/*.yaml eval/fixtures/valid-definition.yaml

step 'semgrep rule tests'
if command -v semgrep >/dev/null 2>&1; then
  semgrep --test --metrics off --config skills/secure-coding/rules tests/semgrep
elif [ "${CI:-}" = "true" ]; then
  echo 'error: semgrep is not installed, and the rule tests must run when CI=true' >&2
  exit 1
else
  echo 'skipped: semgrep is not installed'
fi

step 'tsc'
if [ -f .claude-plugin/types/claude-code/index.d.ts ]; then
  bunx -p typescript@5 tsc -p . --noEmit
else
  echo 'skipped: tsc needs .claude-plugin/types/, which Claude Code writes when it loads the plugin'
fi

echo 'ci: all checks passed'
