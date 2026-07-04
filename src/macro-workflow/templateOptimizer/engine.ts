import type {
  AggregateTemplateJudgment,
  TemplateCandidate,
  TemplateFixtureJudgment,
  TemplateOptimizationFixture,
} from "../../generated/baml_client/index.js";

export interface TemplateOptimizerDeps {
  generateChallenger(args: GenerateChallengerArgs): Promise<TemplateCandidate>;
  judgeFixture(args: JudgeFixtureArgs): Promise<TemplateFixtureJudgment>;
  aggregateJudgments(args: AggregateJudgmentsArgs): Promise<AggregateTemplateJudgment>;
}

export interface TemplateOptimizerArgs {
  baseline: TemplateCandidate;
  fixtures: TemplateOptimizationFixture[];
  iterations: number;
  candidatesPerIteration: number;
  strategies: string[];
  minimumDelta: number;
  minimumDecisionConfidence: number;
  deps: TemplateOptimizerDeps;
}

export interface GenerateChallengerArgs {
  baseline: TemplateCandidate;
  incumbent: TemplateCandidate;
  fixtures: TemplateOptimizationFixture[];
  iterationIndex: number;
  candidateIndex: number;
  strategy: string;
  rejectedMoveTraceSummary: string;
  leaderboard: TemplateCandidate[];
}

export interface JudgeFixtureArgs {
  fixture: TemplateOptimizationFixture;
  incumbent: TemplateCandidate;
  challenger: TemplateCandidate;
  iterationIndex: number;
  candidateIndex: number;
  strategy: string;
}

export interface AggregateJudgmentsArgs {
  fixtures: TemplateOptimizationFixture[];
  incumbent: TemplateCandidate;
  challenger: TemplateCandidate;
  fixtureJudgments: TemplateFixtureJudgment[];
  iterationIndex: number;
  candidateIndex: number;
  strategy: string;
}

export interface TemplateOptimizerIteration {
  index: number;
  candidateIndex: number;
  strategy: string;
  challenger: TemplateCandidate;
  fixtureJudgments: TemplateFixtureJudgment[];
  aggregateJudgment: AggregateTemplateJudgment;
  replacedIncumbent: boolean;
}

export interface TemplateOptimizerResult {
  finalIncumbent: TemplateCandidate;
  baseline: TemplateCandidate;
  iterations: TemplateOptimizerIteration[];
  rejectedMoves: string[];
  leaderboard: TemplateCandidate[];
}

export async function optimizeTemplate(args: TemplateOptimizerArgs): Promise<TemplateOptimizerResult> {
  let incumbent = args.baseline;
  const iterations: TemplateOptimizerIteration[] = [];
  const rejectedMoves: string[] = [];
  const leaderboard: TemplateCandidate[] = [args.baseline];

  for (let index = 0; index < args.iterations; index += 1) {
    for (let candidateIndex = 0; candidateIndex < args.candidatesPerIteration; candidateIndex += 1) {
      const strategy =
        args.strategies[(index + candidateIndex) % args.strategies.length] ?? "coverage-focused";
      const challenger = await args.deps.generateChallenger({
        baseline: args.baseline,
        incumbent,
        fixtures: args.fixtures,
        iterationIndex: index,
        candidateIndex,
        strategy,
        rejectedMoveTraceSummary: compactRejectedMoveTrace(rejectedMoves),
        leaderboard,
      });
      const fixtureJudgments = await Promise.all(
        args.fixtures.map((fixture) =>
          args.deps.judgeFixture({
            fixture,
            incumbent,
            challenger,
            iterationIndex: index,
            candidateIndex,
            strategy,
          }),
        ),
      );
      const aggregateJudgment = await args.deps.aggregateJudgments({
        fixtures: args.fixtures,
        incumbent,
        challenger,
        fixtureJudgments,
        iterationIndex: index,
        candidateIndex,
        strategy,
      });
      const replacedIncumbent = shouldReplaceIncumbent({
        aggregateJudgment,
        minimumDelta: args.minimumDelta,
        minimumDecisionConfidence: args.minimumDecisionConfidence,
      });

      iterations.push({
        index,
        candidateIndex,
        strategy,
        challenger,
        fixtureJudgments,
        aggregateJudgment,
        replacedIncumbent,
      });

      if (replacedIncumbent) {
        incumbent = challenger;
        leaderboard.push(challenger);
      } else {
        rejectedMoves.push(
          aggregateJudgment.rejectedMoveSummary?.trim() ||
            buildRejectedMoveSummary({
              challenger,
              aggregateJudgment,
              minimumDelta: args.minimumDelta,
              minimumDecisionConfidence: args.minimumDecisionConfidence,
            }),
        );
      }
    }
  }

  return {
    finalIncumbent: incumbent,
    baseline: args.baseline,
    iterations,
    rejectedMoves,
    leaderboard,
  };
}

function shouldReplaceIncumbent(args: {
  aggregateJudgment: AggregateTemplateJudgment;
  minimumDelta: number;
  minimumDecisionConfidence: number;
}): boolean {
  return (
    args.aggregateJudgment.replacementDecision === "replace-with-challenger" &&
    args.aggregateJudgment.scoreDelta >= args.minimumDelta &&
    args.aggregateJudgment.criticalRegressionCount === 0 &&
    (args.minimumDecisionConfidence <= 0 ||
      args.aggregateJudgment.decisionConfidence >= args.minimumDecisionConfidence)
  );
}

function compactRejectedMoveTrace(rejectedMoves: string[]): string {
  if (rejectedMoves.length === 0) {
    return "No rejected moves yet.";
  }
  return rejectedMoves
    .slice(-5)
    .map((move, index) => `${index + 1}. ${move}`)
    .join("\n");
}

function buildRejectedMoveSummary(args: {
  challenger: TemplateCandidate;
  aggregateJudgment: AggregateTemplateJudgment;
  minimumDelta: number;
  minimumDecisionConfidence: number;
}): string {
  const reasons: string[] = [];
  if (args.aggregateJudgment.replacementDecision !== "replace-with-challenger") {
    reasons.push(`aggregate decision was ${args.aggregateJudgment.replacementDecision}`);
  }
  if (args.aggregateJudgment.scoreDelta < args.minimumDelta) {
    reasons.push(
      `score delta ${args.aggregateJudgment.scoreDelta} is below minimum delta ${args.minimumDelta}`,
    );
  }
  if (args.aggregateJudgment.criticalRegressionCount > 0) {
    reasons.push(`${args.aggregateJudgment.criticalRegressionCount} critical regressions`);
  }
  if (
    args.minimumDecisionConfidence > 0 &&
    args.aggregateJudgment.decisionConfidence < args.minimumDecisionConfidence
  ) {
    reasons.push(
      `decision confidence ${args.aggregateJudgment.decisionConfidence} is below minimum ${args.minimumDecisionConfidence}`,
    );
  }
  const rationale = reasons.length > 0 ? reasons.join("; ") : args.aggregateJudgment.rationale;
  return `Rejected ${args.challenger.id}: ${rationale}`;
}
