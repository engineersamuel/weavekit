#!/usr/bin/env bash
# Turn-end safety net for Codex CLI (and any other harness wired to it).
#
# Per-edit PostToolUse hook coverage for file-editing tools has historically
# been inconsistent for some harnesses (e.g. Codex's apply_patch), so this
# runs once per turn (the "Stop" event) and auto-fixes/formats whatever is
# currently git-dirty (modified or untracked), as a backstop for
# scripts/hooks/post-tool-use.sh. Generated code under src/generated/** is
# excluded, since it's owned by `baml-cli generate`'s own formatter.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

modified_ts_js=$(git diff --name-only --diff-filter=ACMR -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' ':!src/generated/**' 2>/dev/null || true)
untracked_ts_js=$(git ls-files --others --exclude-standard -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' ':!src/generated/**' 2>/dev/null || true)
all_ts_js=$(printf '%s\n%s\n' "$modified_ts_js" "$untracked_ts_js" | sort -u | sed '/^$/d')

if [ -n "$all_ts_js" ]; then
  echo "$all_ts_js" | xargs -r nubx oxlint --fix >/dev/null 2>&1 || true
fi

# src/generated/** is excluded via .oxfmtrc.json (owned by `baml-cli
# generate`'s own formatter, not oxfmt) but filter it here too for clarity.
modified_formattable=$(git diff --name-only --diff-filter=ACMR -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' '*.json' '*.yaml' '*.yml' '*.md' ':!src/generated/**' 2>/dev/null || true)
untracked_formattable=$(git ls-files --others --exclude-standard -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' '*.json' '*.yaml' '*.yml' '*.md' ':!src/generated/**' 2>/dev/null || true)
all_formattable=$(printf '%s\n%s\n' "$modified_formattable" "$untracked_formattable" | sort -u | sed '/^$/d')
if [ -n "$all_formattable" ]; then
  echo "$all_formattable" | xargs -r nubx oxfmt >/dev/null 2>&1 || true
fi

exit 0
