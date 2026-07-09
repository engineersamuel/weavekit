#!/usr/bin/env bash
# Shared PostToolUse hook body for Copilot CLI, Claude Code, and Codex CLI.
#
# Reads the hook JSON payload from stdin (tolerates the Copilot-native
# camelCase schema, the Claude Code / VS Code-compatible snake_case schema,
# and Codex's apply_patch schema), extracts the file path(s) touched by an
# edit/write/apply_patch call, and:
#   - runs `oxlint --fix` on any touched *.ts/tsx/js/jsx/mjs/cjs file (safe:
#     oxlint only rewrites the specific fixable issues it finds).
#   - runs `oxfmt` on a touched file ONLY if it is newly added (not present
#     at git HEAD), since oxfmt reformats whole files and this repo has not
#     been fully reformatted yet (see AGENTS.md).
#
# Never fails the calling harness: all real work is best-effort (`|| true`)
# so a formatter/linter hiccup never blocks the agent's turn.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

payload="$(cat)"

extract_paths() {
  # Claude Code / VS Code-compatible: tool_input.file_path
  # Copilot native: toolArgs.path
  printf '%s' "$payload" | jq -r '
    [
      (.tool_input.file_path // empty),
      (.toolArgs.path // empty)
    ] | .[] | select(length > 0)
  ' 2>/dev/null || true
  # Codex apply_patch: tool_input.command holds the raw patch body with
  # "*** Add File: <path>" / "*** Update File: <path>" markers.
  printf '%s' "$payload" | jq -r '(.tool_input.command // empty)' 2>/dev/null \
    | grep -E '^\*\*\* (Add|Update|Delete) File: ' \
    | sed -E 's/^\*\*\* (Add|Update|Delete) File: //' || true
}

to_relpath() {
  local f="$1"
  case "$f" in
    "$REPO_ROOT"/*) printf '%s' "${f#"$REPO_ROOT"/}" ;;
    *) printf '%s' "$f" ;;
  esac
}

files="$(extract_paths | sort -u)"
[ -z "$files" ] && exit 0

while IFS= read -r file; do
  [ -z "$file" ] && continue
  [ -f "$file" ] || continue

  case "$file" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs)
      nubx oxlint --fix "$file" >/dev/null 2>&1 || true
      ;;
  esac

  case "$file" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.yaml|*.yml|*.md)
      relfile="$(to_relpath "$file")"
      if ! git cat-file -e "HEAD:$relfile" 2>/dev/null; then
        nubx oxfmt "$file" >/dev/null 2>&1 || true
      fi
      ;;
  esac
done <<< "$files"

exit 0
