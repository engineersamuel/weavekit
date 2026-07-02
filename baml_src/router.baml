class RoutingDecision {
  clientName string?
  model string
  reasoningEffort string?
  rationale string
}

function RouteModelCall(taskKind: string, summary: string, candidates: string[]) -> RoutingDecision {
  client CopilotProxyGpt5Mini
  prompt #"
    {{ _.role("system") }}
    You are a fast model router for a decision-council workflow. Pick the single best
    option for this task. Respond immediately; do not deliberate.

    {{ _.role("user") }}
    Task kind: {{ taskKind }}
    Task summary: {{ summary }}
    Candidate client names (choose clientName from these): {{ candidates }}

    Rules:
    - clientName MUST be one of the candidate names, or null if none fits.
    - model MUST be the exact concrete model id implied by your choice:
      CopilotProxyGpt5Mini -> gpt-5-mini
      CopilotProxyGpt54 -> gpt-5.4
      CopilotProxyGpt55 -> gpt-5.5
      CopilotProxyClaudeOpus48 -> claude-opus-4.8
      CopilotProxyClaudeSonnet5 -> claude-sonnet-5
      CopilotProxyClaudeSonnet46 -> claude-sonnet-4-6
      CopilotProxyClaudeHaiku45 -> claude-haiku-4-5
      CopilotProxyGrokCodeFast1 -> grok-code-fast-1
    - reasoningEffort is one of "low", "medium", "high", "xhigh", or null.
    - rationale is one short sentence.

    {{ ctx.output_format }}
  "#
}
