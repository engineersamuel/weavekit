class VerificationAudit {
  projectId string
  summary string
  verificationCommands string[] @description("Existing project commands that verify correctness, such as tests, typecheck, lint, or CI checks.")
  verificationSurfaces string[] @description("Current verification surfaces discovered in the target project.")
  gaps string[] @description("Current verification gaps that could be improved without changing product behavior.")
  evidence EvidenceReference[] @description("Repository-only evidence references supporting the audit.")
}

class VerificationOpportunityScore {
  confidence float
  impact float
  risk float
  implementationCost float
}

class VerificationOpportunity {
  id string
  title string
  currentVerificationGap string
  targetChange string
  allowedChangeKind "test" | "lint" | "typecheck" | "format" | "script" | "ci" | "docs"
  score VerificationOpportunityScore
  evidence EvidenceReference[]
  proofCommands string[] @description("Commands that should prove the verification-only improvement worked.")
  speculative bool
}

class VerificationOpportunityReview {
  opportunities VerificationOpportunity[]
  nonApplicableGaps string[]
  rankingRationale string
}

class VerificationOpportunityResearchReport {
  opportunityId string
  objective string
  report DeepResearchReport
}

class VerificationRecommendationReview {
  status "accepted" | "rejected"
  selectedOpportunity VerificationOpportunity?
  rationale string
  rejectionReason string?
  proofCommands string[]
}

function DistillVerificationAudit(projectJson: string, rawAudit: string) -> VerificationAudit {
  client CopilotProxyGpt55
  prompt #"
    {{ _.role("system") }}
    Distill a repository-only verification audit into the VerificationAudit contract.
    Do not include external research. Preserve only target-project evidence.

    {{ _.role("user") }}
    Project JSON:
    {{ projectJson }}

    Raw audit transcript:
    {{ rawAudit }}

    {{ ctx.output_format }}
  "#
}

function MapVerificationOpportunities(audit: VerificationAudit) -> VerificationOpportunityReview {
  client CopilotProxyClaudeOpus48
  prompt #"
    {{ _.role("system") }}
    Map the verification audit into at most a few verification-only improvement opportunities.
    A valid opportunity must be limited to tests, lint/typecheck/format config, scripts, CI checks, or docs for verification commands.
    Missing baseline feedback-loop practices are valid non-speculative opportunities when the audit has repository evidence that they are absent.
    Baseline practices include lint scripts/config, formatter scripts/config, git commit hooks such as Husky or lefthook, lint-staged checks, coverage scripts, 100% coverage thresholds, and CI.
    Do not mark these baseline opportunities speculative merely because the project has not explicitly requested them before; the absence evidence is the project-specific evidence.
    Do not recommend product bug fixes or broad rewrites just to satisfy a formatter.
    Use low scores or nonApplicableGaps when the audit evidence does not justify a strict high-confidence improvement.

    {{ _.role("user") }}
    Verification audit:
    {{ audit }}

    {{ ctx.output_format }}
  "#
}

function RefineVerificationOpportunitiesWithResearch(
  audit: VerificationAudit,
  initialReview: VerificationOpportunityReview,
  researchReports: VerificationOpportunityResearchReport[]
) -> VerificationOpportunityReview {
  client CopilotProxyGpt55
  prompt #"
    {{ _.role("system") }}
    Refine the initial verification-only opportunity ranking using external deep research about tools, libraries, frameworks, and proof approaches.

    Repository evidence remains the source of truth for whether each gap exists.
    You may update targetChange, allowedChangeKind, score, proofCommands, speculative, title, currentVerificationGap wording, nonApplicableGaps, and rankingRationale when external research improves the implementation approach.
    Do not create opportunities for gaps that were not present in the initial review.
    Do not add external sources as repository evidence proving the gap exists.
    Keep each opportunity verification-only: tests, lint/typecheck/format config, scripts, CI checks, or docs for verification commands.
    Lower confidence or mark speculative when external research suggests the approach is immature, risky, stale, or mismatched.

    {{ _.role("user") }}
    Repository-only verification audit:
    {{ audit }}

    Initial repository-evidenced opportunity review:
    {{ initialReview }}

    External deep research reports keyed by opportunity:
    {{ researchReports }}

    {{ ctx.output_format }}
  "#
}

function ReviewVerificationRecommendation(
  audit: VerificationAudit,
  selectedOpportunity: VerificationOpportunity?
) -> VerificationRecommendationReview {
  client CopilotProxyGpt55
  prompt #"
    {{ _.role("system") }}
    Review the selected verification improvement as a strict final gate.
    Accept only one high-confidence, verification-only recommendation.
    Reject if it is speculative, lacks evidence, lacks proof commands, changes product behavior, fixes product bugs, or requires broad unrelated rewrites.

    {{ _.role("user") }}
    Verification audit:
    {{ audit }}

    Selected opportunity:
    {{ selectedOpportunity }}

    {{ ctx.output_format }}
  "#
}
