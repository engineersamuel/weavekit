# 0007 — Preserve evidence-grounded Opportunity reasoning

Status: accepted

## Context

An Opportunity preserves a project-specific recommendation and its scores, but that compact result
can lose the inquiry behind the recommendation: plausible rival explanations, the strongest
disconfirming signal, and cases where the recommendation should not apply. Losing those artifacts
makes downstream automation and review less able to challenge an otherwise persuasive result.

## Decision

The BAML `Opportunity` contract gains three additive optional fields:

- `rivalExplanationsConsidered` for materially distinct alternative explanations;
- `negativeSignal` for the strongest evidence that weakens or contradicts the Opportunity; and
- `negativeCases` for evidence-backed cases where the Opportunity should not apply.

`PersonaCritique` normalization has matching optional targets for `rivalExplanations` and
`negativeCases`, preserving those artifacts when a persona supplies them. BAML-generated types are
the canonical application contract; no parallel hand-authored TypeScript shape is introduced. The
existing `OpportunityScore` metric/reasoning fields remain unchanged.

## Prompt policy

Populate these fields only when source and Target project evidence supports them. Otherwise omit
them. Prompts must not fabricate rivals to fill the schema or preserve weak, repetitive alternatives
that add noise without materially challenging the Opportunity.

## Compatibility and migration

All three fields are optional, so older persisted JSON and fixtures remain valid without a bulk
migration. The fixtures `opportunity-with-reasoning-artifacts.json` and
`opportunity-without-reasoning-artifacts.json` demonstrate the populated and omitted forms,
respectively.

## Enforcement and promotion path

`missing-rival-hypotheses` exists in the `verifyOpportunityPromotion` helper as an advisory for an
otherwise promotable, non-speculative Opportunity. Helper callers receive the issue while the
verification result remains valid unless another blocking issue exists. The helper currently has
no production caller, so live Runs do not yet surface this advisory. BAML schema and generated-type
errors remain hard validation failures.

Blocking promotion requires both reliable adoption and a way to distinguish missing inquiry from
a legitimate evidence-grounded conclusion that rivals were considered and none were material:

1. **One-time reproducible adoption audit.** Audit persisted artifacts for accepted Opportunities,
   not live telemetry. Choose a start Run ID, then enumerate artifacts in stable Run order until 50
   eligible observations are identified. Freeze both the start and end Run IDs before inspecting
   field presence. Count only accepted, non-speculative individual Opportunities, uniquely keyed by
   `(runId, opportunityId)`; deduplicate retries and do not count bundles as additional
   observations. Record the numerator, denominator, frozen boundaries, and result in an amendment
   to this ADR or a linked issue or decision record. Adoption is reliable only when strictly fewer
   than five of the 50 observations lack a nonblank `rivalExplanationsConsidered` entry.
2. **Evidence-grounded exemption.** Define an explicit representation or equivalent accepted
   contract for “rivals considered; none material found,” and add focused tests proving that the
   existing automated verification accepts it. This representation must follow the same
   evidence-only prompt policy; it must not become a way to manufacture compliance.

Until both conditions are met and tested, absence remains advisory regardless of the audit result.
Afterward, the existing verification result may make `missing-rival-hypotheses` blocking without
making the optional BAML fields required, preserving persisted-artifact compatibility. Do not add a
new command or gate.

## Constraints

- This change adds no durable cadence or work queue, preserving
  [ADR 0001](./0001-no-durable-work-queue.md).
- It adds no human approval gate or new verification gate, preserving
  [ADR 0003](./0003-elicitation-vs-verification-gates.md). Any future blocking change modifies
  the existing automated verification only after the adoption and exemption criteria above are
  met.
- It adds no runtime persona or adversary pass; this change only preserves reasoning already
  supported by evidence and available model output.
- Budget behavior and cost ceilings remain unchanged.

## Considered options

1. **Add optional evidence-grounded reasoning fields — chosen.** This preserves useful inquiry for
   downstream automation and review while remaining compatible with existing artifacts.
2. **Make the fields required — rejected.** Required fields would invalidate older persisted data
   and encourage fabricated or low-value rivals when the evidence does not support them.
3. **Run a persona or adversary pass for every Opportunity — deferred.** That could generate deeper
   challenges, but it is a higher-cost runtime expansion outside this contract-preservation change.
4. **Keep only the existing recommendation and scores — rejected.** This retains compatibility but
   continues discarding evidence about alternatives and failure cases.

## Consequences

Opportunity artifacts can carry richer, evidence-grounded reasoning without changing existing
score semantics or promotion validity. Consumers must tolerate the fields being absent. Helper
callers can see advisory gaps without invalidating an otherwise valid result; surfacing those gaps
in live Runs is a separate future wiring step if desired. Audit adoption alone cannot justify
blocking absence without the evidence-grounded exemption contract.
