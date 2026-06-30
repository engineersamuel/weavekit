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
  title string
  scope string
  filesLikelyTouched string[]
  validationCommands string[]
  risks string[]
  rawPlanArtifactPath string
}

function DistillSourceAnalysis(sourceArtifactJson: string, rawResearch: string) -> SourceAnalysis {
  client DefaultClient
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
  client DefaultClient
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
  client DefaultClient
  prompt #"
    {{ _.role("system") }}
    Distill repository/project research into a compact ProjectBrief. Include cited project evidence.

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
  client DefaultClient
  prompt #"
    {{ _.role("system") }}
    Map source lessons to this project. Produce project-specific opportunities, explicit non-applicable lessons, and any valid bundles.
    Bundles require rationale, shared change surface, combined user value, separation risk, and max PR scope.

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

function DistillPlanArtifact(opportunityJson: string, rawPlan: string) -> PlanArtifactSummary {
  client DefaultClient
  prompt #"
    {{ _.role("system") }}
    Distill a Copilot plan-mode transcript into a PlanArtifactSummary.

    {{ _.role("user") }}
    Opportunity or bundle JSON:
    {{ opportunityJson }}

    Raw plan transcript:
    {{ rawPlan }}

    {{ ctx.output_format }}
  "#
}
