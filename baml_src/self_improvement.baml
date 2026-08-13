class SubmindTraceObservation {
  name string
  type string
  status string
  summary string
  model string?
  durationMs int?
}

class SubmindTraceSummary {
  traceId string
  url string?
  rootInput string?
  rootOutput string?
  observations SubmindTraceObservation[]
}

class SelfImprovementFinding {
  severity "BLOCKING" | "IMPORTANT" | "SUGGESTION"
  category "MISSION_DEVIATION" | "INEFFICIENT_ROUTING" | "ERROR_OR_RETRY" | "MISSED_REQUIREMENT" | "OTHER"
  title string
  description string
  evidence string[]
  suggestedTicketBody string
}

class SelfImprovementReport {
  summary string
  findings SelfImprovementFinding[]
}

function AnalyzeSubmindTrace(
  ticket: LinearTicketInput,
  missionStatements: string[],
  trace: SubmindTraceSummary
) -> SelfImprovementReport {
  client DefaultClient
  prompt #"
    {{ _.role("system") }}
    You are Mastermind's typed self-improvement auditor. Audit an autonomous coding agent's
    executed Submind trace against the frozen Linear ticket and the provided mission statements.
    Identify only concrete, evidence-backed deviations, failure patterns, or systemic inefficiencies
    that materially matter for future runs.

    Rules:
    - Compare the executed path against the ticket's requirements, acceptance criteria, and the
      mission statements' behavioral intent.
    - Report findings only when the trace provides concrete evidence. Do not invent vague,
      speculative, or generic "could be better" feedback.
    - Prefer findings about mission deviation, inefficient routing, redundant delegation, avoidable
      error or retry loops, ignored requirements, missed verification, or other systemic execution
      issues.
    - If nothing notable is wrong, return an empty findings array and a positive summary that says
      the trace appears aligned with the mission statements and ticket intent.
    - Each finding must include specific evidence strings grounded in the provided trace,
      missionStatements, or ticket text.
    - suggestedTicketBody must be ready to paste into a Linear ticket description for exactly that
      one finding, including the problem, why it matters, and concrete acceptance criteria or
      follow-up expectations.
    - Keep findings deduplicated. Do not split one issue into many overlapping findings.
    - The summary should concisely state the overall alignment or the most important systemic gaps.

    {{ _.role("user") }}
    Frozen Linear ticket:
    {{ ticket }}

    Mission statement excerpts:
    {{ missionStatements }}

    Normalized Submind trace summary:
    {{ trace }}

    {{ ctx.output_format }}
  "#
}
