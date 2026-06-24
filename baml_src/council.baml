generator typescript {
  output_type "typescript"
  output_dir "../src/generated"
  default_client_mode "async"
  module_format "esm"
  version "0.220.0"
}

client<llm> DefaultClient {
  provider "openai-generic"
  options {
    base_url env.BAML_OPENAI_BASE_URL
    api_key env.BAML_OPENAI_API_KEY
    model env.BAML_MODEL
  }
}

class RawPersonaResult {
  personaId string
  text string
}

class PersonaCritique {
  personaId string
  summary string
  claims string[]
  risks string[]
  questions string[]
  recommendations string[]
}

class PersonaFailure {
  personaId string
  message string
  retryable bool
}

class RoundAssessment {
  roundNumber int
  consensus string
  disagreements string[]
  confidence float
  convergence float
  shouldContinue bool
  diminishingReturns bool
  nextRoundBrief string?
}

class CouncilReport {
  recommendation string
  rationale string[]
  strongestObjections string[]
  unresolvedQuestions string[]
  confidence float
  convergence float
  nextExperiment string
  failedPersonas PersonaFailure[]
}

function NormalizePersonaCritique(raw: RawPersonaResult) -> PersonaCritique {
  client DefaultClient
  prompt #"
    Normalize this persona response into the requested critique schema.
    Preserve the personaId exactly.

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
    You are the Judge reducer for a design council. You are not a debating persona.
    Assess whether the council should continue or stop.
    Continue only when another round is likely to produce materially better guidance.

    Round number: {{ roundNumber }}
    Critiques: {{ critiques }}
    Persona failures: {{ failures }}

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
    Create a decision-ready Design Council report.
    Do not write a transcript. Focus on recommendation, rationale, objections,
    unresolved questions, confidence, convergence, and the next experiment.

    Critiques: {{ critiques }}
    Assessments: {{ assessments }}
    Persona failures: {{ failures }}

    {{ ctx.output_format }}
  "#
}
