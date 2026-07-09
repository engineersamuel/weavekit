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
  applicability float @description("How directly the source lesson applies to the target project.")
  applicabilityReasoning string @description("One or two sentences justifying the applicability score, citing the specific source lesson and project-brief evidence (change surfaces, constraints, goals) that support or limit the fit.")
  impact float @description("Expected user or maintainer value if the opportunity is implemented.")
  impactReasoning string @description("One or two sentences justifying the impact score, citing the concrete user/maintainer value or lack thereof, grounded in project evidence.")
  confidence float @description("Confidence that the source and project evidence support this opportunity.")
  confidenceReasoning string @description("One or two sentences justifying the confidence score, citing how strong or weak the corroborating source and project evidence is.")
  implementationCost float @description("Estimated implementation effort and complexity cost.")
  implementationCostReasoning string @description("One or two sentences justifying the implementation cost score, citing the scope of files/systems likely touched and any complexity drivers.")
  risk float @description("Risk of regressions, unnecessary complexity, or poor fit.")
  riskReasoning string @description("One or two sentences justifying the risk score, citing specific regression, complexity, or poor-fit concerns from the evidence.")
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
  planFilePath string? @description("Absolute path to the full Copilot plan.md copied from the plan-mode session into the run output directory. Set by the workflow harness; always null here.")
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
    CRITICAL: The project's canonical id and displayName are provided in the Project JSON below. Use those exact values as the projectId and displayName fields in the ProjectBrief. Do not infer or override them from anything mentioned in the research transcript — the transcript may reference other tools or repositories that are not the target project.
    The changeSurfaces must describe locations within the target project's workingTree (from the Project JSON), not locations in any workflow runner, orchestration tool, or other repository.

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
    Do not emit overlapping standalone opportunities that are implementation subsets of the same change. If multiple changes must ship together, emit one cohesive opportunity or one valid bundle, and make the member opportunities non-overlapping slices with clear separation risk.
    If one opportunity's implementation outline already includes another opportunity's target change (for example schema change + adapter + tests for the same score model), merge them into a single opportunity or represent them only through a bundle so downstream planning does not produce duplicate plans.
    Prioritize actionable product/project improvements that apply the source artifact's core behavior to the target project.
    Do not promote implementation plumbing, endpoint abstraction, adapter layers, logging, or safety controls unless the ProjectBrief evidence shows the target project currently has that exact problem.
    If a source lesson is only an implementation detail of the source and does not improve the target project's user workflow, put it in nonApplicableLessons.
    If no high-quality source-to-project improvement exists, return low scores or nonApplicableLessons instead of forcing a recommendation.
    Every score field must be paired with its own one-or-two sentence *Reasoning field that cites specific evidence (source lesson content, project-brief facts, or change-surface constraints) rather than restating the score in words.
    CRITICAL: Opportunities must propose changes exclusively within the target project's working tree (identified by projectBrief.projectId and projectBrief.displayName). Never propose changes to the workflow automation tool that ran this analysis (e.g., weakekit), its orchestration scripts, its plans/ directory, its src/ code, its CI configuration, or any validation plan documents stored in the workflow runner's repository. Those are the runner, not the target project. If a lesson only reveals a problem with how the workflow runner processes or identifies the target project, put it in nonApplicableLessons rather than creating an opportunity.

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
    Set planFilePath to null. The workflow harness populates it from the session context.

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
