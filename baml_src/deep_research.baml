class DeepResearchConfig {
  providers string[] @description("Provider names to query, such as exa, grok, copilot-last30days, tavily, or perplexity.")
  maxIterations int @description("Maximum iterative research rounds.")
  questionsPerIteration int @description("Target number of questions to generate per iteration.")
  maxResultsPerQuestion int @description("Maximum normalized source results to keep per question/provider.")
  providerRetryAttempts int @description("Number of retry attempts for a provider research node after the first failed attempt.")
  visualize bool @description("Whether the workflow should add an optional visual-plan node after the markdown report.")
}

class DeepResearchEvidence {
  id string @description("Stable evidence id within the workflow run.")
  provider string @description("Provider that produced the evidence.")
  questionId string @description("Research question id this evidence addresses.")
  query string @description("Search query or retrieval prompt that produced the result.")
  url string? @description("Source URL when available.")
  title string? @description("Source title when available.")
  excerpt string? @description("Short excerpt or snippet.")
  content string? @description("Fetched or provider-supplied content when available.")
  sourceQuality string @description("Source quality label, such as primary, secondary, official, forum, or unknown.")
  provenance string @description("Provider/tool provenance, such as exa mcp web_search_exa/web_fetch_exa, grok cli with x_search, or copilot sdk with last30days skill.")
}

class DeepResearchQuestion {
  id string @description("Stable id for the question, unique across a run.")
  text string @description("Research question text.")
  rationale string @description("Why this question matters for the objective.")
  researchMode "local-only" | "official-docs" | "web-lookup" | "recency-social" | "deep-research" @description("Provider routing mode. Use local-only for repository-evidence questions that should not call external providers; official-docs for setup/API syntax/docs questions; web-lookup for lightweight current web lookup; recency-social for recent community/social/issues questions; deep-research for open-ended tradeoff/framework/risk/rollout questions.")
  researchModeRationale string @description("Brief explanation of why this question uses the selected researchMode.")
  priority int @description("Higher priority questions should be researched first.")
  providerHints string[] @description("Provider names that are likely to work well for this question.")
  searchQueries string[] @description("Concrete search queries providers should run.")
  completionCriteria string[] @description("Signals that this question has enough evidence.")
  status string @description("Runtime status such as pending, researched, complete, or blocked.")
  dependencies string[] @description("Other question ids that should be answered first.")
}

class ResearchQuestionSet {
  iteration int @description("Iteration number these questions belong to.")
  questions DeepResearchQuestion[] @description("Questions to research in this iteration.")
}

class DeepResearchPriorState {
  iteration int
  completedQuestionIds string[]
  evidence DeepResearchEvidence[]
  assessments ResearchIterationAssessment[]
}

class ResearchQuestionCoverage {
  questionId string
  coverageScore float @description("0 to 1 estimate of whether the question has enough evidence.")
  evidenceQuality string @description("Overall evidence quality for the question.")
  contradictions string[]
  gaps string[]
}

class ResearchIterationAssessment {
  iteration int
  questionCoverage ResearchQuestionCoverage[]
  contradictions string[]
  newFollowUpQuestions DeepResearchQuestion[]
  answerSufficient bool
  stopReason string
}

class DeepResearchFinding {
  title string
  summary string
  evidenceIds string[]
  confidence string
}

class DeepResearchEvidenceMatrixEntry {
  questionId string
  evidenceId string
  relevance string
  quality string
}

class DeepResearchReportSource {
  id string
  provider string
  url string
  title string
  quality string
}

class DeepResearchReport {
  objective string
  methodology string
  findings DeepResearchFinding[]
  evidenceMatrix DeepResearchEvidenceMatrixEntry[]
  contradictions string[]
  gaps string[]
  confidence string
  sources DeepResearchReportSource[]
  markdown string @description("Complete cited Markdown report.")
}

class DeepResearchCompiledReport {
  markdown string @description("Complete cited Markdown report.")
}

function GenerateResearchQuestions(prompt: string, priorState: DeepResearchPriorState, config: DeepResearchConfig) -> ResearchQuestionSet {
  client CopilotProxyGpt55
  prompt #"
    {{ _.role("system") }}
    Generate bounded deep-research questions for an iterative, in-process workflow.
    Use stable ids. Prefer concrete search queries that can be sent to Exa, Grok, and Copilot last30days.
    Set researchMode for every question:
    - local-only: repository-evidence or gap-existence questions that should not call external providers.
    - official-docs: setup, API syntax, configuration, install, command semantics, or "how do I use this framework/tool" questions. Prefer exa in providerHints.
    - web-lookup: lightweight current web/documentation lookup that does not require expensive synthesis. Prefer exa in providerHints.
    - recency-social: recent issues, recent community sentiment, last-30-days reports, X/social/forum signals. Prefer grok and copilot-last30days in providerHints.
    - deep-research: open-ended framework choices, tradeoffs, risks, rollout strategy, cost controls, or disputed recommendations that need broader synthesis across providers.
    Use researchModeRationale to explain the cost/coverage tradeoff in one short sentence.
    Use providerHints to steer web/source lookup to exa, X/community recency lookup to grok, and broad last-30-days community synthesis to copilot-last30days.
    Avoid search operator domain filters such as site:x.com in searchQueries; write plain keyword queries and let providerHints route recency/community lookup.
    Respect questionsPerIteration and provider hints. Do not repeat completed questions.

    {{ _.role("user") }}
    Research prompt:
    {{ prompt }}

    Prior state:
    {{ priorState }}

    Config:
    {{ config }}

    {{ ctx.output_format }}
  "#
}

function AssessResearchIteration(
  questionSet: ResearchQuestionSet,
  evidence: DeepResearchEvidence[],
  priorState: DeepResearchPriorState
) -> ResearchIterationAssessment {
  client CopilotProxyGpt55
  prompt #"
    {{ _.role("system") }}
    Assess evidence coverage for this research iteration. Identify contradictions and gaps.
    Set answerSufficient true only when the evidence can support a useful cited report for the original objective.
    If more research is useful, emit focused follow-up questions.

    {{ _.role("user") }}
    Question set:
    {{ questionSet }}

    Evidence:
    {{ evidence }}

    Prior state:
    {{ priorState }}

    {{ ctx.output_format }}
  "#
}

function CompileDeepResearchReport(prompt: string, finalState: DeepResearchPriorState) -> DeepResearchCompiledReport {
  client CopilotProxyClaudeOpus48
  prompt #"
    {{ _.role("system") }}
    Compile a concise but complete deep research report.
    Return exactly the required structured output with the `markdown` field populated.
    The `markdown` value is required even when evidence is thin; in that case be explicit about limits.

    The Markdown report must include these sections:
    - # Deep Research Report
    - ## Methodology
    - ## Findings
    - ## Contradictions And Gaps
    - ## Confidence
    - ## Sources

    Use citations from the source list/evidence ids.

    {{ _.role("user") }}
    Research prompt:
    {{ prompt }}

    Final state:
    {{ finalState }}

    {{ ctx.output_format }}
  "#
}
