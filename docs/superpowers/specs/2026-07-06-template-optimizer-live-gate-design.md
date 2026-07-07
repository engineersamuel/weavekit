# Template Optimizer Live Gate Design

## Objective

Improve the source-to-project template optimizer so a fixture-winning challenger is not automatically treated as adoptable. The optimizer should run a real source-to-project comparison only after fixture judging finds a candidate-ready challenger, reject live losers such as a `6.6` candidate against an `8.0` incumbent, feed the live critique into the next challenger attempt, and stop only when the configured live threshold is met or the configured budget is exhausted.

## Context

The current template optimizer has a cheap fixture loop in `src/macro-workflow/templateOptimizer/engine.ts`. It generates challengers, judges them against optimization fixtures, aggregates scores through `minimumDelta` and `minimumDecisionConfidence`, and records a `finalIncumbent`.

The recent real source-to-project trial showed the missing gate. The fixture optimizer recommended `source-to-project-advisory-coverage-challenger`, but a real-output LLM judge scored the baseline `8.0` and the optimized trial `6.6`. The system should have rejected that live result, kept the baseline, generated a new challenger with the live critique, and re-judged until a candidate met configured live thresholds or the budget ended.

## Requirements

- WHEN fixture judging does not produce a candidate-ready challenger, THE SYSTEM SHALL keep the current incumbent without running a live trial.
- WHEN fixture judging produces a candidate-ready challenger, THE SYSTEM SHALL run a real incumbent-vs-challenger source-to-project trial before adoption.
- WHEN the live judge scores the challenger below the live threshold, THE SYSTEM SHALL keep the incumbent and record the rejection.
- WHEN a challenger is rejected by live judging, THE SYSTEM SHALL feed the live judge critique into the next challenger generation attempt.
- WHEN the live trial budget is exhausted without a live winner, THE SYSTEM SHALL keep the incumbent.
- WHEN a challenger meets fixture and live thresholds, THE SYSTEM SHALL promote it as the final incumbent.
- IF the incumbent live trial cannot run, THEN THE SYSTEM SHALL mark the live gate blocked and SHALL NOT adopt the challenger.
- IF the challenger live trial or live judge fails, THEN THE SYSTEM SHALL reject the live candidate and SHALL NOT adopt it.
- THE SYSTEM SHALL use a separate live-trial threshold instead of reusing fixture thresholds.
- THE SYSTEM SHALL default to one live trial per optimizer run for cost control.

## Architecture

Add a new deep module at the template optimizer seam:

```ts
optimizeTemplateWithLiveGate(args): Promise<TemplateOptimizerWithLiveGateResult>
```

The existing `optimizeTemplate(...)` remains the cheap fixture optimizer module. It should continue to own challenger generation, fixture judging, aggregate fixture thresholds, fixture rejected moves, and the fixture leaderboard.

The new module owns the expensive acceptance gate. It calls the fixture optimizer, decides whether a candidate is worth a live trial, runs incumbent and challenger trials, judges real outputs, applies live thresholds, records live rejected moves, and returns a final adopt-or-keep result.

This shape keeps callers from manually sequencing `optimize-template`, `source-to-project:try-optimized-template`, and ad hoc LLM judging. The caller learns one interface, while the live-gate implementation hides orchestration, thresholding, error handling, and artifact bookkeeping.

## Interfaces

The existing `TemplateOptimizerDeps` should stay focused on synthetic fixture optimization:

```ts
interface TemplateOptimizerDeps {
  generateChallenger(args: GenerateChallengerArgs): Promise<TemplateCandidate>;
  judgeFixture(args: JudgeFixtureArgs): Promise<TemplateFixtureJudgment>;
  aggregateJudgments(args: AggregateJudgmentsArgs): Promise<AggregateTemplateJudgment>;
}
```

Add a separate live-gate seam:

```ts
interface TemplateOptimizerLiveGateDeps {
  runIncumbentTrial(args: RunLiveTemplateTrialArgs): Promise<LiveTemplateTrialResult>;
  runCandidateTrial(args: RunLiveTemplateTrialArgs): Promise<LiveTemplateTrialResult>;
  judgeLiveOutputs(args: JudgeLiveTemplateOutputsArgs): Promise<LiveTemplateJudgment>;
}
```

The generator should receive both fixture and live rejection context:

```ts
type GenerateChallengerArgs = {
  compactTraceSummary: string;
  compactLiveTrialTraceSummary?: string;
  // existing fields unchanged
};
```

The live-gate config should include:

```ts
type TemplateOptimizerLiveGateConfig = {
  enabled: boolean;
  maxLiveTrials: number; // default 1
  minimumLiveDelta: number;
  minimumLiveDecisionConfidence: number;
  sourceToProjectPrompt: string;
  project: string;
  mode: "advisory" | "autonomous-pr";
};
```

## Control flow

1. Start with the current incumbent.
2. Run the existing fixture optimizer pass.
3. If the fixture pass returns the incumbent, write a keep-current-template result with no live decision.
4. If the fixture pass returns a challenger, run the incumbent baseline source-to-project trial unless a reusable matching baseline trial is provided.
5. Run the challenger source-to-project trial through the non-destructive candidate path.
6. Judge the real outputs against the live criteria:
   - relevance to the source material
   - actionability for Weavekit
   - evidence grounding
   - coverage of static DAG templates and dynamic workflows
   - specificity of file and surface recommendations
   - whether the optimizer complexity paid off
7. Promote the challenger only when it beats the incumbent by `minimumLiveDelta`, meets `minimumLiveDecisionConfidence`, and has no live critical regression.
8. If it loses, record a live rejected move containing scores, critique, trial IDs, and threshold reasons.
9. Feed the compact live rejection trace into the next challenger generation attempt.
10. Stop when a live winner is found or `maxLiveTrials` is exhausted.

## Artifact model

Extend `optimizer-run.json` so the UI can distinguish fixture readiness from live adoptability.

Suggested additions:

```ts
type TemplateOptimizerRunArtifact = {
  status:
    | "keep-current-template"
    | "fixture-candidate-ready"
    | "live-candidate-ready"
    | "live-candidate-rejected"
    | "live-gate-blocked";
  fixtureDecision: {
    candidateId: string;
    replacementDecision: "keep-incumbent" | "replace-with-challenger";
    incumbentAggregateScore: number;
    challengerAggregateScore: number;
    scoreDelta: number;
    decisionConfidence: number;
  };
  liveDecision?: {
    incumbentCandidateId: string;
    challengerCandidateId: string;
    incumbentRunId: string;
    challengerRunId: string;
    winner: "incumbent" | "challenger";
    incumbentScore: number;
    challengerScore: number;
    scoreDelta: number;
    decisionConfidence: number;
    threshold: {
      minimumLiveDelta: number;
      minimumLiveDecisionConfidence: number;
    };
    adoptionDecision: "keep-incumbent" | "adopt-challenger";
    rationale: string;
    critiqueForNextChallenger: string;
  };
  liveRejectedMoves: string[];
};
```

`finalIncumbent` should mean the candidate that survived both gates. A fixture winner that fails live judging should be visible as a rejected live trial, not as an adoptable final incumbent.

## Error handling

- Baseline trial failure blocks the live gate because there is no trustworthy incumbent output to compare against.
- Challenger trial failure rejects the challenger and keeps the incumbent.
- Live judge failure rejects the challenger and keeps the incumbent unless the run is explicitly configured to retry live judging.
- Any workflow state with `status !== "passed"` is not a successful live trial.
- No fallback should produce success-shaped output when a workflow node or live judge failed.

## Testing strategy

- Unit test: fixture winner rejected by live judge keeps incumbent and records live critique.
- Unit test: fixture winner accepted by live judge becomes final incumbent.
- Unit test: live challenger trial failure keeps incumbent and records the failed run.
- Unit test: baseline trial failure returns `live-gate-blocked` and does not adopt.
- Artifact test: a fixture replacement with a live `6.6` against an incumbent `8.0` writes `live-candidate-rejected`, keeps the incumbent, and records the live judge rationale.
- Generator test: a later challenger request includes the compact live rejected move trace.
- CLI test: the configured default runs at most one live trial unless `--max-live-trials` is set.

## Open decisions

- Exact default `minimumLiveDelta` and `minimumLiveDecisionConfidence` values should be selected during implementation planning.
- Whether the live baseline trial can be reused across optimizer runs should be decided separately; the first implementation can require an explicit matching run ID or rerun the baseline.
- The live judge schema can start local to the live-gate module and move into BAML once the output shape stabilizes.

