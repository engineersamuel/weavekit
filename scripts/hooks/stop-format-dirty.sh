#!/usr/bin/env bash
# Turn-end safety net for Codex CLI (and any other harness wired to it).
#
# Per-edit PostToolUse hook coverage for file-editing tools has historically
# been inconsistent for some harnesses (e.g. Codex's apply_patch), so this
# runs once per turn (the "Stop" event) and auto-fixes/formats whatever is
# currently git-dirty, as a backstop for scripts/hooks/post-tool-use.sh.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

modified_ts_js=$(git diff --name-only --diff-filter=ACMR -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' 2>/dev/null || true)
untracked_ts_js=$(git ls-files --others --exclude-standard -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' 2>/dev/null || true)
all_ts_js=$(printf '%s\n%s\n' "$modified_ts_js" "$untracked_ts_js" | sort -u | sed '/^$/d')

if [ -n "$all_ts_js" ]; then
  echo "$all_ts_js" | xargs -r nubx oxlint --fix >/dev/null 2>&1 || true
fi

# Oxfmt reformats whole files; only auto-format newly added (untracked) files
# so editing an existing, pre-oxfmt file doesn't trigger a large unrelated
# diff (this repo has not been fully reformatted yet — see AGENTS.md).
untracked_formattable=$(git ls-files --others --exclude-standard -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' '*.json' '*.yaml' '*.yml' '*.md' 2>/dev/null || true)
if [ -n "$untracked_formattable" ]; then
  echo "$untracked_formattable" | xargs -r nubx oxfmt >/dev/null 2>&1 || true
fi

exit 0
