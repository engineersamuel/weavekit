class EvidenceReference {
  id string @description("Stable reference id within this Run.")
  source string @description("URL, file path, section, page, or repo file reference.")
  quote string? @description("Short supporting quote when safe to record.")
}

class SourceAnalysis {
  sourceId string
  title string
  accessLevel string @description("public, local, private, or restricted.")
  summary string
  claims string[]
  transferableLessons string[]
  evidence EvidenceReference[]
}

class CorroborationReport {
  sourceId string
  corroboratedClaims string[]
  disputedClaims string[]
  competingViews string[]
  citations EvidenceReference[]
}

class ProjectBrief {
  projectId string
  displayName string
  architecture string
  constraints string[]
  goals string[]
  changeSurfaces string[]
  validationCommands string[]
  risks string[]
  evidence EvidenceReference[]
}

class OpportunityScore {
  applicability float
  impact float
  confidence float
  implementationCost float
  risk float
}

class Opportunity {
  id string
  title string
  lesson string
  projectChange string
  changeSurface string
  score OpportunityScore
  evidence EvidenceReference[]
  speculative bool
}

class NonApplicableLesson {
  lesson string
  reason string
  evidence EvidenceReference[]
}

class OpportunityBundle {
  id string
  opportunityIds string[]
  rationale string
  sharedChangeSurface string
  combinedUserValue string
  separationRisk string
  maxPrScope string
}

class OpportunityCouncilReview {
  opportunities Opportunity[]
  nonApplicableLessons NonApplicableLesson[]
  bundles OpportunityBundle[]
  rankingRationale string
}

class PlanArtifactSummary {
  opportunityIds string[]
  title string @description("Short name for the recommended improvement plan.")
  recommendation string @description("One or two sentences stating the actual improvement being recommended, in product/project language.")
  problemSolved string @description("The current pain, gap, or risk this recommendation addresses.")
  sourceLessonApplied string @description("The specific lesson from the source artifact that justifies this recommendation.")
  targetChange string @description("Concrete change to make in the target project, before listing files or tests.")
  expectedUserValue string @description("What gets better for users or maintainers if this plan is implemented.")
  implementationOutline string[] @description("Ordered high-level implementation steps. Keep these readable and action-oriented.")
  scope string @description("Detailed implementation scope and boundaries.")
  filesLikelyTouched string[] @description("Likely files, directories, or modules affected by the plan.")
  validationCommands string[] @description("Commands or checks that should prove the plan worked.")
  risks string[] @description("Material implementation or product risks.")
  rawPlanArtifactPath string?
}

class FinalRecommendationReview {
  status "accepted" | "rejected"
  actionable bool @description("True only when the recommendation can be implemented as a concrete, bounded project improvement.")
  improvesProject bool @description("True only when the recommendation is likely to improve the target project for users or maintainers.")
  unnecessaryComplexity bool @description("True when the recommendation adds complexity not justified by the source/project evidence.")
  benefitOutweighsCost bool @description("True when any added complexity or implementation cost is justified by the expected benefit.")
  complexityAssessment string
  rationale string
  rejectionReason string?
  telegramSummary string? @description("Short user-facing summary suitable for Telegram when the review rejects the recommendation. May be null for accepted recommendations.")
}

function DistillSourceAnalysis(sourceArtifactJson: string, rawResearch: string) -> SourceAnalysis {
  client CopilotProxyGpt55
  prompt #"
    {{ _.role("system") }}
    Distill the raw source-reading transcript into the SourceAnalysis contract.
    Preserve only safe, source-grounded claims. Every major claim and lesson needs evidence.

    {{ _.role("user") }}
    Source artifact JSON:
    {{ sourceArtifactJson }}

    Raw research transcript:
    {{ rawResearch }}

    {{ ctx.output_format }}
  "#
}

function DistillCorroboration(sourceAnalysis: SourceAnalysis, rawResearch: string) -> CorroborationReport {
  client CopilotProxyGpt55
  prompt #"
    {{ _.role("system") }}
    Distill corroborating research for the source claims. Separate corroborated claims, disputed claims, and competing views.

    {{ _.role("user") }}
    Source analysis:
    {{ sourceAnalysis }}

    Corroboration transcript:
    {{ rawResearch }}

    {{ ctx.output_format }}
  "#
}

function DistillProjectBrief(projectJson: string, rawResearch: string) -> ProjectBrief {
  client CopilotProxyGpt55
  prompt #"
    {{ _.role("system") }}
    Distill repository/project research into a compact ProjectBrief focused on the current source-to-project objective.
    Preserve project evidence that proves where the source findings can apply, where they cannot apply, validation commands, constraints, and risks.
    Do not turn source-specific research back into a generic project overview.

    {{ _.role("user") }}
    Project JSON:
    {{ projectJson }}

    Raw project research transcript:
    {{ rawResearch }}

    {{ ctx.output_format }}
  "#
}

function MapSourceToProject(
  sourceAnalysis: SourceAnalysis,
  corroboration: CorroborationReport,
  projectBrief: ProjectBrief
) -> OpportunityCouncilReview {
  client CopilotProxyClaudeOpus48
  prompt #"
    {{ _.role("system") }}
    Map source lessons to this project. Produce project-specific opportunities, explicit non-applicable lessons, and any valid bundles.
    Bundles require rationale, shared change surface, combined user value, separation risk, and max PR scope.
    Prioritize actionable product/project improvements that apply the source artifact's core behavior to the target project.
    Do not promote implementation plumbing, endpoint abstraction, adapter layers, logging, or safety controls unless the ProjectBrief evidence shows the target project currently has that exact problem.
    If a source lesson is only an implementation detail of the source and does not improve the target project's user workflow, put it in nonApplicableLessons.
    If no high-quality source-to-project improvement exists, return low scores or nonApplicableLessons instead of forcing a recommendation.

    {{ _.role("user") }}
    Source analysis:
    {{ sourceAnalysis }}

    Corroboration:
    {{ corroboration }}

    Project brief:
    {{ projectBrief }}

    {{ ctx.output_format }}
  "#
}

function DistillPlanArtifact(opportunityJson: string, rawPlan: string, rawPlanArtifactPath: string) -> PlanArtifactSummary {
  client CopilotProxyGpt5Mini
  prompt #"
    {{ _.role("system") }}
    Distill a Copilot plan-mode transcript into a PlanArtifactSummary.
    The most important fields are recommendation, problemSolved, sourceLessonApplied, targetChange, expectedUserValue, and implementationOutline.
    Do not make the UI reader infer the recommendation from a long scope paragraph.
    Use scope for detailed implementation boundaries only.
    Set rawPlanArtifactPath exactly to the supplied raw plan artifact path. Do not invent or rewrite it.

    {{ _.role("user") }}
    Opportunity or bundle JSON:
    {{ opportunityJson }}

    Raw plan artifact path:
    {{ rawPlanArtifactPath }}

    Raw plan transcript:
    {{ rawPlan }}

    {{ ctx.output_format }}
  "#
}

function ReviewFinalRecommendation(
  originalPrompt: string,
  source: string,
  sourceAnalysis: SourceAnalysis,
  corroboration: CorroborationReport,
  projectBrief: ProjectBrief,
  plans: PlanArtifactSummary[]
) -> FinalRecommendationReview {
  client CopilotProxyGpt55
  prompt #"
    {{ _.role("system") }}
    Review the final source-to-project recommendation as a strict actionability and complexity gate.
    Accept only if the recommendation is actionable and would improve the target project without unnecessary complexity.
    If it does add complexity, accept only when the benefit clearly outweighs the implementation and maintenance cost.
    Reject recommendations that are vague, mostly plumbing, weakly connected to the source, not project-specific, already solved by the project, or more complex than their value justifies.
    When rejecting, write a concise telegramSummary that tells the user why the workflow stopped before implementation.

    {{ _.role("user") }}
    Original prompt:
    {{ originalPrompt }}

    Source URL, blog, or source reference:
    {{ source }}

    Source analysis:
    {{ sourceAnalysis }}

    Corroboration:
    {{ corroboration }}

    Project brief:
    {{ projectBrief }}

    Final plan recommendation(s):
    {{ plans }}

    {{ ctx.output_format }}
  "#
}
