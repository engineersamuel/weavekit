/**
 * Copilot runtime built-in tool names, taken from tool calls observed in real sessions.
 *
 * `availableTools` is a *match filter*, not a declaration (see `SessionConfigBase.availableTools`
 * in @github/copilot-sdk): a tool is enabled when it matches an entry. An entry that matches no
 * registered tool is silently ignored - no error, no log line - so a misspelt name simply removes
 * a capability the session was meant to have. That has now happened three times: "shell" instead
 * of "bash", then "read_file" and "list_dir", which the runtime never registers at all.
 *
 * Never guess a name into a tool list. Add one here only after observing it in a session log.
 */
export const COPILOT_BUILT_IN_TOOL_NAMES = [
  "apply_patch",
  "ask_user",
  "bash",
  "create",
  "glob",
  "grep",
  "rg",
  "skill",
  "str_replace_editor",
  "task",
  "view",
  "web_fetch",
  "web_search",
] as const;

const KNOWN_NAMES: ReadonlySet<string> = new Set(COPILOT_BUILT_IN_TOOL_NAMES);

/**
 * Returns the entries of an `availableTools` list that name no known built-in tool. Source-qualified
 * patterns (`builtin:*`, `custom:rlm`, `mcp:*`) address other tool sources and are not checked here.
 */
export function unknownCopilotToolNames(tools: readonly string[]): string[] {
  return tools.filter((tool) => !tool.includes(":") && !KNOWN_NAMES.has(tool));
}
