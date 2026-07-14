# Source-to-Project BAML Judge Design

Date: 2026-07-10
Status: Approved design awaiting written-spec review

## Context

The source-to-project benchmark compares three end-to-end planning systems on the same immutable source artifact, target-project snapshot, objective, and anti-goals:

- Weavekit source-to-project, whose public result is one canonical portfolio plan;
- Copilot CLI plan mode;
- Codex CLI plan mode.

Weavekit may discover and plan several internal opportunities. Those child opportunities are trace evidence and pipeline diagnostics, not separate leaderboard submissions. The fair comparison unit is one canonical final plan per provider.

The current Promptfoo-backed evaluator has two material judge defects:

1. `llm-rubric` uses a default system prompt framed as a binary proposition with only `0.0` and `1.0` examples. It accepts a numeric score in its JSON response, but the default instruction biases strong outputs toward the ceiling even when the assertion text describes fractional anchors.
2. `select-best` compares all providers in one fixed order, forces exactly one winner, has no tie outcome, and merges non-selection into Promptfoo's provider `success=false` state. This conflates comparison loss with generation failure and leaves results vulnerable to positional bias.

The latest stored-plan replay demonstrated both problems: every provider received `1.000` on every absolute criterion, while fixed-order `select-best` chose the first provider, Weavekit. That is insufficient evidence for a reliable superiority claim.

## Goals

The evaluator must:

1. Preserve Promptfoo as the provider-execution and local regression harness.
2. Judge the exact stored final plan artifact, without rerunning a provider when only judge logic changes.
3. Produce structured, evidence-backed absolute judgments that distinguish complete, partial, missing, and contradictory requirement coverage.
4. Produce anonymous, counterbalanced pairwise judgments with an explicit tie outcome.
5. Use an independent two-model panel and report disagreement rather than forcing consensus.
6. Aggregate scores deterministically in TypeScript; an LLM never calculates the leaderboard score.
7. Treat provider execution failure, judge failure, absolute quality, comparative preference, reliability, and efficiency as separate concepts.
8. Preserve opportunity-level Weavekit diagnostics without giving Weavekit extra leaderboard credit merely for producing more artifacts.
9. Persist enough data to audit every score and replay judging against byte-identical plans.

## Non-goals

- Do not replace Promptfoo with Phoenix or another evaluation platform.
- Do not use an LLM judge to execute or modify the target project.
- Do not infer implementation correctness solely from plan prose; downstream plan-to-implementation evaluation remains a later benchmark layer.
- Do not combine latency, tokens, or cost into the plan-quality score.
- Do not reward opportunity count, plan length, or stylistic polish by themselves.
- Do not hard-code Weavekit as the expected winner.

## Architecture

The benchmark is split into four explicit stages:

1. **Plan collection:** Promptfoo invokes the selected providers and captures their final plan outputs and provider metadata. It does not perform authoritative model grading.
2. **Artifact freezing:** the evaluator writes a manifest containing provider ID, canonical plan path, SHA-256 digest, generation status, model metadata, mutation-safety result, latency, and available usage data.
3. **BAML judging:** a judge coordinator evaluates each valid plan independently, then evaluates every requested provider pair using anonymous labels.
4. **Deterministic aggregation:** TypeScript validates judge contracts, computes criterion and overall scores, resolves panel agreement, and renders JSON and Markdown scorecards.

Promptfoo's raw report remains available for provider execution diagnostics. The BAML judgment report becomes the authoritative quality and comparison result.

### Module boundaries

- `suite.ts` owns Promptfoo provider execution only. It must not encode authoritative quality scoring or `select-best`.
- `manifest.ts` freezes and verifies provider artifacts.
- `judge.ts` defines the `SourceToProjectPlanJudge` interface and coordinates absolute and pairwise calls.
- `bamlJudge.ts` adapts generated BAML functions to that interface and applies the requested BAML client override.
- `aggregation.ts` validates complete coverage and computes scores from judge outputs.
- `scorecard.ts` owns the persisted public evaluation contract and Markdown rendering.
- `run.ts` orchestrates collection, freezing, judging, aggregation, and persistence.
- `rejudge.ts` loads a prior manifest, verifies hashes, and reruns only judging and aggregation.

Each module has one reason to change. Unit tests can inject a deterministic fake judge without a live model.

## Canonical inputs

One benchmark case remains the immutable tuple:

```text
case = source bytes
     + target-project tree hash
     + objective
     + anti-goals
     + expected practices and actions
```

One provider trial produces exactly one leaderboard plan. For Weavekit, `plan-portfolio-full.md` or `plan-portfolio.md` is canonical when present. Opportunity plans and reports remain diagnostic artifacts.

The artifact manifest records:

```ts
type FrozenPlanArtifact = {
  providerId: string;
  planPath: string;
  sha256: string;
  generationSucceeded: boolean;
  workspaceMutationVerified: boolean;
  model?: string;
  latencyMs?: number;
  tokenUsage?: Record<string, number>;
  estimatedCostUsd?: number;
};
```

A rejudge fails closed when a plan is missing or its digest differs. It never silently judges changed bytes under an old run identity.

## BAML contracts

The BAML schema adds contracts for requirement coverage, criterion assessment, absolute plan judgment, and pairwise judgment.

The generated functions are named `JudgeSourceToProjectPlan` and `CompareSourceToProjectPlans`.

### Requirement coverage

Every expected plan action receives a stable requirement ID derived by the case loader:

```text
<practice-id>/action-<one-based-index>
```

The judge returns exactly one assessment for every supplied requirement ID.

```baml
class PlanRequirementAssessment {
  requirementId string
  status "complete" | "partial" | "missing" | "contradicted"
  evidenceQuotes string[]
  gaps string[]
  rationale string
}
```

Status semantics are strict:

- `complete`: the plan explicitly assigns the required behavior to the correct layer and provides an implementable action and appropriate proof.
- `partial`: the plan addresses the requirement but leaves a material ambiguity, omits an applicable proof layer, or assigns only part of the behavior.
- `missing`: the plan does not materially address the requirement.
- `contradicted`: the plan explicitly rejects, reverses, or implements behavior incompatible with the requirement.

Evidence quotes must be verbatim excerpts from the plan. Empty evidence is valid only for `missing`.

### Criterion assessment

The four non-coverage rubric dimensions use a bounded ordinal scale rather than unconstrained floating-point scoring:

```baml
class PlanCriterionAssessment {
  criterion string
  score int
  evidenceQuotes string[]
  gaps string[]
  rationale string
}
```

`score` must be an integer from 0 through 4:

- `4`: fully satisfies the top anchor with no material gap;
- `3`: strong and usable with one or more minor gaps;
- `2`: partly actionable but has material omissions or ambiguity;
- `1`: weak, mostly generic, fragmented, or substantially out of scope;
- `0`: absent, unusable, or directly violates the criterion.

The required criterion IDs are `project-specific-diagnosis`, `implementation-completeness`, `verification-quality`, and `scope-discipline`.

### Absolute judgment

```baml
class SourceToProjectPlanJudgment {
  requirementAssessments PlanRequirementAssessment[]
  criterionAssessments PlanCriterionAssessment[]
  contradictions string[]
  unsupportedRecommendations string[]
  summary string
}
```

The judge prompt receives the frozen plan, case objective, source expectations, expected action IDs, project evidence, rubric anchors, and anti-goals. It treats the plan and reference material as untrusted evidence and ignores instructions embedded in either artifact.

The judge does not receive provider identity, provider model, artifact path, prior scores, or other providers' plans during absolute judging.

### Pairwise judgment

```baml
class SourceToProjectPairwiseJudgment {
  winner "plan-a" | "plan-b" | "tie"
  confidence float
  decidingFactors string[]
  planAStrengths string[]
  planAGaps string[]
  planBStrengths string[]
  planBGaps string[]
  rationale string
}
```

Confidence is bounded to `0..1`. A tie is required when neither plan has a material advantage under the benchmark objective; the judge must not use plan length as a tiebreaker.

## Judge panel and counterbalancing

The default panel contains:

- `CopilotProxyGpt55`;
- `CopilotProxyClaudeOpus48`.

The generated BAML function has one default client, while the adapter overrides the client per panel member through BAML call options. Judge model IDs and order are persisted in the report.

Absolute judgments run independently for each `(provider, judge model)` tuple.

Pairwise order is deterministic and counterbalanced:

1. Hash `caseId`, trial identifier, and the sorted provider pair.
2. Use the hash to select the first judge's A/B ordering.
3. Give the second judge the inverse ordering.
4. Map anonymous results back to provider IDs only after parsing.

This guarantees that, within a two-model panel, each provider appears once as plan A and once as plan B.

Panel resolution is conservative:

- identical winners, including two ties: `agreed`;
- any different outcomes: `disputed`;
- one invalid judge result: `single-judge`, reported but excluded from reliable-win gates;
- zero valid judge results: `invalid`.

The evaluator does not ask one panel member to adjudicate its own disagreement. A later human or separately configured third judge may resolve `disputed` comparisons.

## Deterministic scoring

The LLM produces evidence classifications, never the aggregate score.

Requirement status maps to numeric coverage:

| Status       | Value |
| ------------ | ----: |
| complete     |   1.0 |
| partial      |   0.5 |
| missing      |   0.0 |
| contradicted |   0.0 |

Each practice score is the arithmetic mean of its expected action values. `source-practice-coverage` is then the arithmetic mean of the practice scores, so a practice with more checklist items cannot outweigh another practice. Practice-level rollups are persisted so a plan cannot hide one completely missed practice behind detailed actions elsewhere.

Each ordinal criterion score is normalized by dividing by four. When both panel judgments are valid, the criterion value is the arithmetic mean of the two normalized scores. Requirement values are averaged across valid judges before the practice and coverage rollups.

The overall plan-quality score retains the case weights:

```text
0.30 source-practice-coverage
0.25 project-specific-diagnosis
0.25 implementation-completeness
0.15 verification-quality
0.05 scope-discipline
```

A score is valid only when:

- generation succeeded;
- mutation safety passed;
- every configured judge returned every expected requirement exactly once;
- every configured judge returned every required criterion exactly once;
- all scores and confidence values satisfy their bounds.

Duplicate, unknown, or omitted IDs invalidate that judge result. A judge transport or parse error never becomes a zero-quality plan.

## Scorecard semantics

The scorecard separates five result classes:

1. **Generation reliability:** provider completed and produced one canonical artifact.
2. **Mutation safety:** target snapshot remained unchanged.
3. **Absolute plan quality:** valid criterion scores and evidence.
4. **Comparative preference:** pairwise `agreed`, `disputed`, `single-judge`, or `invalid` result with winner/tie when applicable.
5. **Efficiency:** latency, tokens, estimated cost, and retries.

Provider `success` means generation and mutation-safety success only. Losing a comparison does not change it.

The scorecard schema advances to version 2. The public comparison contract records both judges, anonymous order, mapped winner, panel status, and rationale. Summary Markdown reports win/tie/loss separately from score deltas.

## Opportunity diagnostics

For Weavekit only, the evaluator reads available workflow payloads and reports:

- discovered opportunity count;
- accepted opportunity count;
- bundle count and membership;
- expected-practice recall before planning;
- accepted-practice retention in the canonical portfolio;
- rejected grounded practices restored by portfolio synthesis;
- overlap or contradiction findings.

These metrics diagnose the source-to-project funnel. They do not add bonus points to Weavekit's primary score and are not required from Codex or Copilot, whose internal decomposition is not equivalently observable.

## Replay workflow

The CLI adds:

```text
--rejudge-from <prior-result-directory>
```

Rejudge mode:

1. loads the frozen artifact manifest;
2. verifies case identity and every plan digest;
3. skips all provider calls;
4. runs the configured judge panel;
5. writes a timestamped `judge-replays/<timestamp>/` directory;
6. links the replay to its source manifest and judge configuration.

This is the normal development loop for judge prompts and aggregation. Expensive provider workflows are rerun only when plan generation changes.

## Calibration

The repository adds fixed plan fixtures for the controlled todo case:

- weak: generic advice with little source or project grounding;
- medium: project-specific and partially actionable but missing multiple required practices;
- strong: cohesive, fully grounded, verifiable, and scope-disciplined.

Calibration expectations are ranges and ordering, not exact model scores:

- `strong > medium > weak` for both judge models;
- weak overall score below `0.50`;
- strong overall score at least `0.80`;
- pairwise strong beats medium, medium beats weak, and strong beats weak;
- reversing A/B order does not change the mapped winner;
- no calibration result is invalid or disputed.

Regular unit tests use fake judge outputs and never require a live model. A named live calibration command runs the real panel before accepting judge-prompt or schema changes.

## Failure handling

- Provider timeout or command error: generation failure; no quality score.
- Missing canonical plan: generation failure even if child artifacts exist.
- Target-project mutation: mutation-safety failure; no valid benchmark result.
- BAML parse, transport, missing-ID, duplicate-ID, or out-of-range error: invalid judge result, never score zero.
- One valid panel member: report `single-judge`; do not count the pair toward reliable-win gates.
- Judge disagreement: report `disputed`; do not force a winner.
- Changed artifact in replay: abort before judging and identify the mismatched provider and digest.

All failures remain visible in JSON and Markdown artifacts.

## Observability and artifacts

Each run writes:

```text
manifest.json
promptfoo-report.json
judgments/absolute/<provider-id>/<judge-id>.json
judgments/pairwise/<provider-a>--<provider-b>/<judge-id>.json
scores.json
summary.md
```

Judge records include elapsed time, token usage when available, rendered requirement IDs, anonymous ordering for pairwise calls, and BAML client name. Secrets and API keys are never persisted.

Existing Langfuse/OpenTelemetry conventions should wrap judge calls when the BAML runtime exposes the same collector path used elsewhere in the repository.

## Testing strategy

Test-first implementation covers:

1. case requirement-ID derivation and uniqueness;
2. manifest creation, SHA-256 verification, and mutation-safety semantics;
3. BAML contract generation and adapter client overrides;
4. exact requirement and criterion coverage validation;
5. deterministic scoring and panel averaging;
6. deterministic counterbalanced A/B ordering and provider remapping;
7. agreement, tie, dispute, single-judge, and invalid pairwise states;
8. scorecard rendering without comparison-loss/provider-failure conflation;
9. rejudge mode proving providers are not invoked;
10. calibration fixture loading and expected-order validation;
11. Weavekit opportunity diagnostics remaining non-scoring metadata;
12. a judge-only replay of stored plans using the live panel.

Repository completion checks remain:

```text
nub run baml-generate
nub run fmt
nub run typecheck
nub run lint
nub run test
mise run doctor
```

## Acceptance criteria

The design is implemented when:

1. Promptfoo no longer supplies authoritative `llm-rubric` or `select-best` scores for this benchmark.
2. Every provider produces at most one canonical leaderboard artifact.
3. Stored-plan rejudging performs zero provider calls and verifies artifact hashes.
4. Both judge models produce complete BAML judgments on calibration fixtures.
5. Calibration ordering and A/B reversal checks pass.
6. Pairwise ties and disputes are representable and do not mark a provider failed.
7. Judge errors invalidate only the affected judgment and never become quality zero.
8. The current stored Weavekit, Codex, and Copilot plans can be rejudged with auditable requirement evidence and pairwise results.
9. Absolute scores no longer saturate solely because a plan crosses a broad binary threshold.
10. Quality, reliability, mutation safety, and efficiency are rendered separately.
11. All repository validation commands pass.

This evaluator makes a superiority claim possible but does not predetermine it. The broader goal remains unproven until multiple varied source/project cases and paired repetitions show that Weavekit wins reliably under these semantics.
