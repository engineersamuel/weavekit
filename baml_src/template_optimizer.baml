class TemplateExpansionCase {
  id string
  trigger string @description("Node, event, or condition that activates this expansion case.")
  conditionSummary string
  nodes WorkflowNode[]
  expectedPayloads string[]
  mustRunBeforeReport bool
  rationale string
}

class ModeTemplatePolicy {
  mode "advisory" | "autonomous-pr"
  enabledForOptimization bool
  expansionCases TemplateExpansionCase[]
  constraints string[]
}

class AdoptionTask {
  title string
  kind "template" | "expander" | "test" | "docs"
  filesLikelyTouched string[]
  newFiles string[]
  description string
  acceptanceChecks string[]
}

class TemplateCandidate {
  id string
  templateId string
  mode "advisory" | "autonomous-pr"
  summary string
  sharedInitialNodes WorkflowNode[]
  modePolicies ModeTemplatePolicy[]
  changedInitialDag bool
  changedExpansionPolicy bool
  requiresAutonomousPrReview bool
  rationale string
  suggestedCodeTouchpoints string[]
  adoptionTasks AdoptionTask[]
}

class TemplateOptimizationFixture {
  id string
  mode "advisory" | "autonomous-pr"
  scenarioSummary string
  sourceLessons string[]
  projectConstraints string[]
  opportunities string[]
  idealFeatures string[]
  mustPreserve string[]
  failureModes string[]
}

class CriterionScore {
  criterion string
  score float @description("Normalized 0..1 score.") @assert(normalized_score, {{ this >= 0 and this <= 1 }})
  rationale string
}

class TemplateFixtureJudgment {
  fixtureId string
  incumbentScore float @description("Normalized 0..1 score.") @assert(normalized_incumbentScore, {{ this >= 0 and this <= 1 }})
  challengerScore float @description("Normalized 0..1 score.") @assert(normalized_challengerScore, {{ this >= 0 and this <= 1 }})
  criteriaScores CriterionScore[]
  criticalRegression bool
  criticalRegressionReason string?
  winner "incumbent" | "challenger"
  rationale string
  critiqueForNextChallenger string
  fixtureGapNotes string[]
  decisionConfidence float @description("Normalized 0..1 score.") @assert(normalized_decisionConfidence, {{ this >= 0 and this <= 1 }})
}

class AggregateTemplateJudgment {
  incumbentId string
  challengerId string
  incumbentAggregateScore float @description("Normalized 0..1 score.") @assert(normalized_incumbentAggregateScore, {{ this >= 0 and this <= 1 }})
  challengerAggregateScore float @description("Normalized 0..1 score.") @assert(normalized_challengerAggregateScore, {{ this >= 0 and this <= 1 }})
  scoreDelta float @description("Difference computed as challengerAggregateScore - incumbentAggregateScore; may be negative.")
  criticalRegressionCount int
  replacementDecision "keep-incumbent" | "replace-with-challenger"
  rationale string
  rejectedMoveSummary string?
  decisionConfidence float @description("Normalized 0..1 score.") @assert(normalized_decisionConfidence, {{ this >= 0 and this <= 1 }})
}

template_string RenderStringList(items: string[]) #"
{% for item in items %}
- {{ item }}
{% endfor %}
"#

template_string RenderWorkflowNodeSummary(node: WorkflowNode) #"
- {{ node.id }} | kind={{ node.kind }} | harness={{ node.harness }} | deps={{ node.dependsOn }} | gates={{ node.gates }} | writeMode={{ node.writeMode }}
"#

template_string RenderWorkflowNodeSummaries(nodes: WorkflowNode[]) #"
{% for node in nodes %}
{{ RenderWorkflowNodeSummary(node) }}
{% endfor %}
"#

template_string RenderAdoptionTaskSummary(task: AdoptionTask) #"
- {{ task.title }} | kind={{ task.kind }}
  filesLikelyTouched:
{{ RenderStringList(task.filesLikelyTouched) }}
  newFiles:
{{ RenderStringList(task.newFiles) }}
  acceptanceChecks:
{{ RenderStringList(task.acceptanceChecks) }}
"#

template_string RenderAdoptionTaskSummaries(tasks: AdoptionTask[]) #"
{% for task in tasks %}
{{ RenderAdoptionTaskSummary(task) }}
{% endfor %}
"#

template_string RenderExpansionCaseSummary(expansion: TemplateExpansionCase) #"
- {{ expansion.id }} | trigger={{ expansion.trigger }} | condition={{ expansion.conditionSummary }} | mustRunBeforeReport={{ expansion.mustRunBeforeReport }}
  node ids:
{% for node in expansion.nodes %}
  - {{ node.id }}
{% endfor %}
"#

template_string RenderModePolicySummary(policy: ModeTemplatePolicy) #"
- policy={{ policy.mode }} | enabledForOptimization={{ policy.enabledForOptimization }}
  constraints:
{{ RenderStringList(policy.constraints) }}
  expansion cases:
{% for expansion in policy.expansionCases %}
{{ RenderExpansionCaseSummary(expansion) }}
{% endfor %}
"#

template_string RenderModePolicySummaries(policies: ModeTemplatePolicy[]) #"
{% for policy in policies %}
{{ RenderModePolicySummary(policy) }}
{% endfor %}
"#

template_string RenderTemplateCandidateSummary(candidate: TemplateCandidate) #"
id: {{ candidate.id }}
templateId: {{ candidate.templateId }}
mode: {{ candidate.mode }}
summary: {{ candidate.summary }}
flags:
- changedInitialDag={{ candidate.changedInitialDag }}
- changedExpansionPolicy={{ candidate.changedExpansionPolicy }}
- requiresAutonomousPrReview={{ candidate.requiresAutonomousPrReview }}
shared initial nodes:
{{ RenderWorkflowNodeSummaries(candidate.sharedInitialNodes) }}
mode policies:
{{ RenderModePolicySummaries(candidate.modePolicies) }}
adoption tasks:
{{ RenderAdoptionTaskSummaries(candidate.adoptionTasks) }}
"#

template_string RenderFixtureSummary(fixture: TemplateOptimizationFixture) #"
- {{ fixture.id }} | mode={{ fixture.mode }} | scenario={{ fixture.scenarioSummary }}
  mustPreserve:
{{ RenderStringList(fixture.mustPreserve) }}
  failureModes:
{{ RenderStringList(fixture.failureModes) }}
  idealFeatures:
{{ RenderStringList(fixture.idealFeatures) }}
"#

template_string RenderFixtureSummaries(fixtures: TemplateOptimizationFixture[]) #"
{% for fixture in fixtures %}
{{ RenderFixtureSummary(fixture) }}
{% endfor %}
"#

template_string RenderFixtureJudgmentSummary(judgment: TemplateFixtureJudgment) #"
- {{ judgment.fixtureId }} | incumbentScore={{ judgment.incumbentScore }} | challengerScore={{ judgment.challengerScore }} | winner={{ judgment.winner }} | criticalRegression={{ judgment.criticalRegression }} | confidence={{ judgment.decisionConfidence }}
  criticalRegressionReason: {{ judgment.criticalRegressionReason }}
  rationale: {{ judgment.rationale }}
  criteria:
{% for score in judgment.criteriaScores %}
  - {{ score.criterion }}={{ score.score }} | {{ score.rationale }}
{% endfor %}
"#

template_string RenderFixtureJudgmentSummaries(judgments: TemplateFixtureJudgment[]) #"
{% for judgment in judgments %}
{{ RenderFixtureJudgmentSummary(judgment) }}
{% endfor %}
"#

function GenerateTemplateChallenger(
  objective: string,
  constraintsSummary: string,
  incumbent: TemplateCandidate,
  compactTraceSummary: string,
  strategy: string,
  fixtures: TemplateOptimizationFixture[]
) -> TemplateCandidate {
  client CopilotProxyClaudeOpus48
  prompt #"
    {{ _.role("system") }}
    You generate a Challenger template for Weavekit's offline Template optimizer.
    Improve template structure only. Do not propose BAML contract changes, runtime prompt implementation changes, or model proxy changes.
    Return a structured TemplateCandidate. Use existing WorkflowNode shape for nodes.

    {{ _.role("user") }}
    Objective:
    {{ objective }}

    Constraints:
    {{ constraintsSummary }}

    Incumbent candidate summary:
    {{ RenderTemplateCandidateSummary(incumbent) }}

    Compact trace summary:
    {{ compactTraceSummary }}

    Strategy:
    {{ strategy }}

    Fixture summaries:
    {{ RenderFixtureSummaries(fixtures) }}

    {{ ctx.output_format }}
  "#
}

function JudgeTemplateFixture(
  objective: string,
  constraintsSummary: string,
  fixture: TemplateOptimizationFixture,
  incumbent: TemplateCandidate,
  challenger: TemplateCandidate
) -> TemplateFixtureJudgment {
  client CopilotProxyGpt55
  prompt #"
    {{ _.role("system") }}
    You are the Template judge for one fixture. Judge plan quality only, not execution cost.
    Mark criticalRegression true if the challenger violates a mustPreserve assertion or worsens a must-not-break behavior.

    {{ _.role("user") }}
    Objective:
    {{ objective }}

    Constraints:
    {{ constraintsSummary }}

    Fixture summary:
    {{ RenderFixtureSummary(fixture) }}

    Incumbent candidate summary:
    {{ RenderTemplateCandidateSummary(incumbent) }}

    Challenger candidate summary:
    {{ RenderTemplateCandidateSummary(challenger) }}

    {{ ctx.output_format }}
  "#
}

function AggregateTemplateJudgments(
  incumbent: TemplateCandidate,
  challenger: TemplateCandidate,
  fixtureJudgments: TemplateFixtureJudgment[],
  minimumDelta: float,
  minimumDecisionConfidence: float
) -> AggregateTemplateJudgment {
  client CopilotProxyGpt55
  prompt #"
    {{ _.role("system") }}
    Aggregate independent fixture judgments. Replace only when the challenger improves by at least minimumDelta,
    has zero critical regressions, and meets minimumDecisionConfidence when that threshold is greater than zero.

    {{ _.role("user") }}
    Incumbent candidate summary:
    {{ RenderTemplateCandidateSummary(incumbent) }}

    Challenger candidate summary:
    {{ RenderTemplateCandidateSummary(challenger) }}

    Fixture judgment summaries:
    {{ RenderFixtureJudgmentSummaries(fixtureJudgments) }}

    Minimum delta:
    {{ minimumDelta }}

    Minimum decision confidence:
    {{ minimumDecisionConfidence }}

    {{ ctx.output_format }}
  "#
}
