# Ticket Review Rubric

## Classification

| Kind           | Required core                                                      |
| -------------- | ------------------------------------------------------------------ |
| User story     | Persona or beneficiary, capability, value, bounded slice           |
| Bug            | Current behavior, expected behavior, reproduction/evidence, impact |
| Technical task | System outcome, constraints, affected boundary, compatibility      |
| Spike          | Question, decision to unlock, time box, evidence deliverable       |
| Operational    | Trigger, runbook outcome, safety, recovery, audit                  |

## Readiness

### Ready

- Intent and outcome are clear
- Scope and non-goals are bounded
- Repository claims are evidenced
- Acceptance criteria are observable
- Verification and validation are both present
- Dependencies and material risks are explicit
- No blocking question remains

### Ready with non-blocking gaps

- Implementation can proceed safely
- Remaining gaps are warnings, documentation follow-ups, or optional refinements
- No product decision or authorization is being guessed

### Blocked

- Required behavior, authorization, ownership, compatibility, or success outcome is unknown
- Evidence conflicts materially
- Proposed changes alter the requested outcome or scope
- Verification or validation cannot be defined responsibly

## Acceptance Criteria

Include:

- Primary successful behavior
- User-visible or caller-visible failure behavior
- Relevant boundaries and invalid inputs
- Concurrency/idempotency when shared state changes
- Recovery after partial failure
- Security, accessibility, performance, audit, or reliability only when material

Avoid:

- Implementation steps presented as user outcomes
- Subjective words such as “fast,” “clean,” or “easy” without a measure
- Criteria that require interpreting hidden intent
- Duplicate checks phrased differently

## Verification vs. Validation

**Verification:** focused automated tests, type checking, lint/build checks, negative cases,
integration checks, telemetry assertions, and recovery tests confirmed by repository evidence.

**Validation:** a representative user/system scenario, expected observable outcome, stakeholder
or product confirmation where necessary, and a success signal that demonstrates the goal was met.

## Evidence

- Repository: `relative/path.ts:Symbol` or `relative/path.ts:line`
- Linear: issue, project, document, or comment identifier
- External: HTTPS URL plus retrieval date
- Confidence is 0–1 and reflects evidence quality, not prose quality
