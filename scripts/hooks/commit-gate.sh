#!/usr/bin/env bash
# Shared PreToolUse commit gate for Copilot CLI, Claude Code, and Codex CLI.
#
# Blocks `git commit` until `nub run lint` and `nub run typecheck` pass, so a
# broken or unlinted commit never lands, regardless of which harness (or
# human, if they bypass the local git pre-commit hook) is driving. This is
# the deterministic backstop for the AGENTS.md instruction to always use
# oxlint/oxfmt.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

payload="$(cat)"

tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // .toolName // empty' 2>/dev/null || true)"
case "$tool_name" in
  Bash|bash) ;;
  *) exit 0 ;;
esac

command="$(printf '%s' "$payload" | jq -r '
  (.tool_input.command // .toolArgs.command // empty) as $c
  | if ($c | type) == "array" then ($c | join(" ")) else $c end
' 2>/dev/null || true)"

if ! printf '%s' "$command" | grep -Eq '(^|[; &|]) *git +commit\b'; then
  exit 0
fi

ERRORS=""

if [ -f package.json ]; then
  if ! LINT_OUT=$(nub run lint 2>&1); then
    ERRORS="${ERRORS}
=== Lint Errors (nub run lint) ===
$(printf '%s' "$LINT_OUT" | tail -40)"
  fi

  if ! TSC_OUT=$(nub run typecheck 2>&1); then
    ERRORS="${ERRORS}
=== Typecheck Errors (nub run typecheck) ===
$(printf '%s' "$TSC_OUT" | tail -40)"
  fi
fi

if [ -n "$ERRORS" ]; then
  REASON="Cannot commit — fix these issues first:${ERRORS}"
  jq -nc --arg reason "$REASON" '{
    permissionDecision: "deny",
    permissionDecisionReason: $reason,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
fi

exit 0
