class PersonaChoiceCandidate {
  id string
  name string
  description string
  archetype string?
  tags string[]
  useWhen string[]
  avoidWhen string[]
}

class PersonaSelectionRequest {
  workflowName string
  workflowPurpose string
  taskPrompt string
  context string[]
  constraints string[]
  roundNumber int?
  roundFocus string?
  previousSelectionIds string[]
  previousRoundSignals string[]
  minPersonas int
  maxPersonas int
  candidates PersonaChoiceCandidate[]
}

class PersonaSelection {
  personaIds string[]
  rationale string
}

function ChoosePersonasForTask(request: PersonaSelectionRequest) -> PersonaSelection {
  client CopilotProxyGpt5Mini
  prompt #"
    {{ _.role("system") }}
    You are a fast persona chooser for reusable Weavekit workflows.
    Select the minimal sufficient personas for the task. Do not choose personas
    merely because they are interesting; choose them only when their candidate
    card is directly useful for the prompt, constraints, workflow purpose, or
    current round focus.

    Rules:
    - personaIds MUST be candidate ids from request.candidates.
    - Return between request.minPersonas and request.maxPersonas ids.
    - Prefer fewer personas when the task is narrow.
    - After establishing task relevance, prefer distinct reasoning methods that
      complement one another.
    - Avoid candidates with materially overlapping domains and methods unless
      deliberate opposition would expose a useful conflict.
    - On later rounds, use request.previousSelectionIds,
      request.previousRoundSignals, and request.roundFocus to add a missing lens
      instead of mechanically repeating the previous panel.
    - Include strategic/philosophical/political personas only when the prompt
      involves incentives, negotiation, internal politics, positioning, career,
      power, timing, or human systems.
    - Include code/design personas when the prompt involves technical design,
      framework choice, module seams, implementation risk, reliability, or tests.
    - rationale is one short sentence.

    {{ _.role("user") }}
    Request: {{ request }}

    {{ ctx.output_format }}
  "#
}
