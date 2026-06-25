class PersonaDefinition {
  id string @description("Stable persona identifier used in downstream reporting and metadata")
  name string @description("Display name for the persona")
  description string @description("Short summary of the persona's role and perspective")
}

class RoundBrief {
  roundNumber int @description("The zero-based or one-based council round number")
  prompt string @description("The design question or prompt that the council should consider")
  focus string @description("The specific decision focus for this round")
}

class RawPersonaResult {
  personaId string @description("The persona identifier that produced the response")
  text string @description("The raw critique text emitted by the persona")
  transcript string[] @description("Short assistant-style transcript lines that capture the persona's reasoning context")
  metadata map<string, string> @description("Small metadata bag for tracing and model attribution")
}

class PersonaCritique {
  personaId string @description("The persona identifier that generated the critique")
  overallSummary string @description("One short sentence that summarizes the persona's overall stance")
  summary string @description("A compact summary of the persona's recommendation")
  claims string[] @description("The strongest supporting claims made by the persona")
  risks string[] @description("The main risks or failure modes the persona highlighted")
  questions string[] @description("The unresolved questions the persona still has")
  recommendations string[] @description("Concrete next steps or recommendations from the persona")
}

class PersonaFailure {
  personaId string @description("The persona identifier that failed")
  message string @description("A concise explanation of the failure")
  retryable bool @description("Whether the failure looks transient and worth retrying")
}

class RoundAssessment {
  roundNumber int @description("The round that this assessment covers")
  consensus string @description("The judge's summary of the current council consensus")
  disagreements string[] @description("The main disagreements still present across personas")
  confidence float @description("The judge's confidence in the assessment")
  convergence float @description("How converged the council currently appears")
  shouldContinue bool @description("Whether another council round is likely to improve the decision")
  diminishingReturns bool @description("Whether additional rounds are likely to yield diminishing returns")
  nextRoundBrief string? @description("Optional follow-up brief for the next round when another round is recommended")
}

class CouncilReport {
  recommendation string @description("The recommended decision or path forward")
  rationale string[] @description("The strongest reasons that support the recommendation")
  strongestObjections string[] @description("The most important objections that remain")
  unresolvedQuestions string[] @description("The open questions that still need investigation")
  confidence float @description("The final confidence score for the recommendation")
  convergence float @description("The final convergence score for the council output")
  nextExperiment string @description("The next experiment or validation step to run")
  finalReportMarkdown string @description("A rich markdown report suitable for human review and file output")
  failedPersonas PersonaFailure[] @description("Any personas that failed during the council run")
}

template_string SocraticQuestionerInstructions() #"
  You are the Socratic Questioner.
  Identify assumptions, ambiguities, and the questions that would most improve this design.
  Do not solve prematurely.
  Surface the hidden assumptions, missing definitions, and unresolved trade-offs that should be clarified before implementation.
"#

template_string DeepModuleDryArchitectInstructions() #"
  You are the Deep Module/DRY Architect.
  Evaluate module depth, seams, interface size, duplicated responsibilities, and whether callers get leverage from the design.
  Focus on design locality, reuse opportunities, and whether the structure is cohesive.
"#

template_string PragmaticBuilderInstructions() #"
  You are the Pragmatic Builder.
  Identify the smallest useful next experiment, implementation slice, or prototype that would validate the design.
  Guard against overbuilding and prefer the least risky path that creates genuine learning.
"#

template_string SkepticInstructions() #"
  You are the Skeptic.
  Challenge weak evidence, optimistic assumptions, reliability gaps, cost risks, and ways this design could fail.
  Emphasize failure modes, hidden dependencies, and the cost of overconfidence.
"#

template_string CritiqueNormalizationInstructions(raw: RawPersonaResult) #"
  Normalize this persona response into the requested critique schema.
  Preserve the personaId exactly.
  Set overallSummary to one short sentence for CLI progress that summarizes
  the persona's overall stance, conclusion, or decision.
"#

template_string CouncilAssessmentInstructions(roundNumber: int, critiques: PersonaCritique[], failures: PersonaFailure[]) #"
  You are the judge reducer for a design council. You are not a debating persona.
  Assess whether the council should continue or stop.
  Continue only when another round is likely to produce materially better guidance.

  Round number: {{ roundNumber }}
  Critiques: {{ critiques }}
  Persona failures: {{ failures }}
"#

template_string CouncilReportInstructions(critiques: PersonaCritique[], assessments: RoundAssessment[], failures: PersonaFailure[]) #"
  Create a decision-ready Design Council report.
  Do not write a transcript. Focus on recommendation, rationale, objections,
  unresolved questions, confidence, convergence, and the next experiment.
  Also include finalReportMarkdown: a rich Markdown report for humans, starting
  with a level-1 heading named Design Council Report and including links/sections that make the
  final artifact useful when written to CouncilReport.md.

  Critiques: {{ critiques }}
  Assessments: {{ assessments }}
  Persona failures: {{ failures }}
"#

function RunSocraticQuestioner(brief: RoundBrief) -> RawPersonaResult {
  client DefaultClient
  prompt #"
    {{ _.role("system") }}
    {{ SocraticQuestionerInstructions() }}

    Round {{ brief.roundNumber }}
    Focus: {{ brief.focus }}

    Design/question:
    {{ brief.prompt }}

    Return a concise critique with claims, risks, questions, and recommendations.
    Keep the output structured and grounded in the current round's context.
    Set personaId to "socratic" in the output.

    {{ ctx.output_format }}
  "#
}

function RunDeepModuleDryArchitect(brief: RoundBrief) -> RawPersonaResult {
  client DefaultClient
  prompt #"
    {{ _.role("system") }}
    {{ DeepModuleDryArchitectInstructions() }}

    Round {{ brief.roundNumber }}
    Focus: {{ brief.focus }}

    Design/question:
    {{ brief.prompt }}

    Return a concise critique with claims, risks, questions, and recommendations.
    Keep the output structured and grounded in the current round's context.
    Set personaId to "deep-module-dry" in the output.

    {{ ctx.output_format }}
  "#
}

function RunPragmaticBuilder(brief: RoundBrief) -> RawPersonaResult {
  client DefaultClient
  prompt #"
    {{ _.role("system") }}
    {{ PragmaticBuilderInstructions() }}

    Round {{ brief.roundNumber }}
    Focus: {{ brief.focus }}

    Design/question:
    {{ brief.prompt }}

    Return a concise critique with claims, risks, questions, and recommendations.
    Keep the output structured and grounded in the current round's context.
    Set personaId to "pragmatic" in the output.

    {{ ctx.output_format }}
  "#
}

function RunSkeptic(brief: RoundBrief) -> RawPersonaResult {
  client DefaultClient
  prompt #"
    {{ _.role("system") }}
    {{ SkepticInstructions() }}

    Round {{ brief.roundNumber }}
    Focus: {{ brief.focus }}

    Design/question:
    {{ brief.prompt }}

    Return a concise critique with claims, risks, questions, and recommendations.
    Keep the output structured and grounded in the current round's context.
    Set personaId to "skeptic" in the output.

    {{ ctx.output_format }}
  "#
}

function NormalizePersonaCritique(raw: RawPersonaResult) -> PersonaCritique {
  client DefaultClient
  prompt #"
    {{ _.role("system") }}
    {{ CritiqueNormalizationInstructions(raw) }}

    {{ _.role("user") }}
    Persona ID: {{ raw.personaId }}
    Raw response:
    {{ raw.text }}

    {{ ctx.output_format }}
  "#
}

function AssessCouncilRound(
  roundNumber: int,
  critiques: PersonaCritique[],
  failures: PersonaFailure[]
) -> RoundAssessment {
  client DefaultClient
  prompt #"
    {{ _.role("system") }}
    {{ CouncilAssessmentInstructions(roundNumber, critiques, failures) }}

    {{ ctx.output_format }}
  "#
}

function CreateCouncilReport(
  critiques: PersonaCritique[],
  assessments: RoundAssessment[],
  failures: PersonaFailure[]
) -> CouncilReport {
  client DefaultClient
  prompt #"
    {{ _.role("system") }}
    {{ CouncilReportInstructions(critiques, assessments, failures) }}

    {{ ctx.output_format }}
  "#
}
