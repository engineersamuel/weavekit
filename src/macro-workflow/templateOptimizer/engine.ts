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
  objective: string;
  constraintsSummary: string;
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
  objective: string;
  constraintsSummary: string;
  baseline: TemplateCandidate;
  incumbent: TemplateCandidate;
  fixtures: TemplateOptimizationFixture[];
  iterationIndex: number;
  candidateIndex: number;
  strategy: string;
  compactTraceSummary: string;
  leaderboard: TemplateCandidate[];
}

export interface JudgeFixtureArgs {
  objective: string;
  constraintsSummary: string;
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
  minimumDelta: number;
  minimumDecisionConfidence: number;
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
  if (args.fixtures.length === 0) {
    throw new Error("Template optimizer requires at least one fixture.");
  }

  let incumbent = args.baseline;
  const iterations: TemplateOptimizerIteration[] = [];
  const rejectedMoves: string[] = [];
  const leaderboard: TemplateCandidate[] = [args.baseline];

  for (let index = 0; index < args.iterations; index += 1) {
    for (let candidateIndex = 0; candidateIndex < args.candidatesPerIteration; candidateIndex += 1) {
      const strategy =
        args.strategies[(index + candidateIndex) % args.strategies.length] ?? "coverage-focused";
      const challenger = await args.deps.generateChallenger({
        objective: args.objective,
        constraintsSummary: args.constraintsSummary,
        baseline: args.baseline,
        incumbent,
        fixtures: args.fixtures,
        iterationIndex: index,
        candidateIndex,
        strategy,
        compactTraceSummary: compactRejectedMoveTrace(rejectedMoves),
        leaderboard,
      });
      const fixtureJudgments = await Promise.all(
        args.fixtures.map((fixture) =>
          args.deps.judgeFixture({
            objective: args.objective,
            constraintsSummary: args.constraintsSummary,
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
        minimumDelta: args.minimumDelta,
        minimumDecisionConfidence: args.minimumDecisionConfidence,
      });
      const fixtureCriticalRegressionCount = countFixtureCriticalRegressions(fixtureJudgments);
      const replacedIncumbent = shouldReplaceIncumbent({
        aggregateJudgment,
        fixtureCriticalRegressionCount,
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
          buildRejectedMoveSummary({
            challenger,
            aggregateJudgment,
            fixtureCriticalRegressionCount,
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
  fixtureCriticalRegressionCount: number;
  minimumDelta: number;
  minimumDecisionConfidence: number;
}): boolean {
  return (
    args.aggregateJudgment.replacementDecision === "replace-with-challenger" &&
    args.aggregateJudgment.scoreDelta >= args.minimumDelta &&
    args.fixtureCriticalRegressionCount === 0 &&
    (args.minimumDecisionConfidence <= 0 ||
      args.aggregateJudgment.decisionConfidence >= args.minimumDecisionConfidence)
  );
}

function countFixtureCriticalRegressions(fixtureJudgments: TemplateFixtureJudgment[]): number {
  return fixtureJudgments.filter((judgment) => judgment.criticalRegression).length;
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
  fixtureCriticalRegressionCount: number;
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
  if (args.fixtureCriticalRegressionCount > 0) {
    reasons.push(`${args.fixtureCriticalRegressionCount} fixture critical regressions`);
  }
  if (
    args.minimumDecisionConfidence > 0 &&
    args.aggregateJudgment.decisionConfidence < args.minimumDecisionConfidence
  ) {
    reasons.push(
      `decision confidence ${args.aggregateJudgment.decisionConfidence} is below minimum ${args.minimumDecisionConfidence}`,
    );
  }
  const aggregateSummary = args.aggregateJudgment.rejectedMoveSummary?.trim();
  if (aggregateSummary) {
    reasons.push(aggregateSummary);
  }
  const rationale = reasons.length > 0 ? reasons.join("; ") : args.aggregateJudgment.rationale;
  return `Rejected ${args.challenger.id}: ${rationale}`;
}
