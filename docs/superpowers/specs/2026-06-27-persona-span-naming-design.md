# Persona-Specific Normalize Span Naming

## Goal

Improve Langfuse trace readability by naming normalize spans with persona identity.

Current:
- `run.council.baml.normalize`

Target (for normalize with persona context):
- `run.council.baml.persona.<personaId>`
- Example: `run.council.baml.persona.skeptic`

## Scope

In scope:
- Span naming logic in `src/decision-council/bamlTelemetry.ts`
- Tests in `tests/decision-council/bamlTelemetry.test.ts`

Out of scope:
- Renaming non-normalize operations (`assess`, `report`, `route-model-call`)
- Changing existing span attributes or payload shape

## Design

1. Add a small helper that determines span name:
   - If operation is `normalize` and personaId is present, emit `run.council.baml.persona.<personaId>`
   - Otherwise emit existing `run.council.baml.<operation>`
2. Keep compatibility attributes unchanged:
   - `gen_ai.operation.name = normalize|assess|report`
   - `weavekit.decision_council.operation = normalize|assess|report`
   - `weavekit.decision_council.persona_id` when present
3. Derive personaId from available telemetry context/arguments used in the normalize path.

## Risks and Mitigations

- Risk: higher span-name cardinality.
  - Mitigation: limit dynamic naming to normalize only.
- Risk: breaks existing queries on span name.
  - Mitigation: keep operation attributes stable for filtering/aggregation.

## Validation

- Update/extend tests to assert:
  - Normalize with persona context uses `run.council.baml.persona.<personaId>`
  - Assess/report names remain unchanged
  - Existing attributes remain unchanged

