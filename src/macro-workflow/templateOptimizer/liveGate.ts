import type { TemplateCandidate } from "../../generated/baml_client/index.js";
import {
  optimizeTemplate,
  type TemplateOptimizerArgs,
  type TemplateOptimizerDeps,
  type TemplateOptimizerIteration,
  type TemplateOptimizerResult,
} from "./engine.js";

export type TemplateOptimizerLiveGateStatus =
  | "keep-current-template"
  | "fixture-candidate-ready"
  | "live-candidate-ready"
  | "live-candidate-rejected"
  | "live-gate-blocked";

export type TemplateOptimizerLiveGateConfig = {
  enabled: boolean;
  maxLiveTrials?: number;
  minimumLiveDelta: number;
  minimumLiveDecisionConfidence: number;
  sourceToProjectPrompt: string;
  project: string;
  mode: "advisory" | "autonomous-pr";
};

export type RunLiveTemplateTrialArgs = {
  candidate: TemplateCandidate;
  sourceToProjectPrompt: string;
  project: string;
  mode: "advisory" | "autonomous-pr";
  trialRole: "incumbent" | "challenger";
  liveTrialIndex: number;
};

export type LiveTemplateTrialResult = {
  runId: string;
  status: string;
  output: string;
  outputDir?: string;
  error?: string;
};

export type JudgeLiveTemplateOutputsArgs = {
  incumbent: TemplateCandidate;
  challenger: TemplateCandidate;
  incumbentTrial: LiveTemplateTrialResult;
  challengerTrial: LiveTemplateTrialResult;
  criteria: string[];
};

export type LiveTemplateJudgment = {
  incumbentScore: number;
  challengerScore: number;
  scoreDelta?: number;
  winner: "incumbent" | "challenger";
  decisionConfidence: number;
  criticalRegression: boolean;
  criticalRegressionReason?: string;
  rationale: string;
  critiqueForNextChallenger: string;
};

export type TemplateOptimizerLiveGateDeps = {
  fixtureOptimizerDeps: TemplateOptimizerDeps;
  runIncumbentTrial(args: RunLiveTemplateTrialArgs): Promise<LiveTemplateTrialResult>;
  runCandidateTrial(args: RunLiveTemplateTrialArgs): Promise<LiveTemplateTrialResult>;
  judgeLiveOutputs(args: JudgeLiveTemplateOutputsArgs): Promise<LiveTemplateJudgment>;
};

export type TemplateOptimizerFixtureDecision = {
  candidateId: string;
  replacementDecision: "keep-incumbent" | "replace-with-challenger";
  incumbentAggregateScore: number;
  challengerAggregateScore: number;
  scoreDelta: number;
  decisionConfidence: number;
};

export type TemplateOptimizerLiveDecision = {
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

export type TemplateOptimizerWithLiveGateResult = TemplateOptimizerResult & {
  status: TemplateOptimizerLiveGateStatus;
  fixtureDecision?: TemplateOptimizerFixtureDecision;
  liveDecision?: TemplateOptimizerLiveDecision;
  liveRejectedMoves: string[];
  liveGate: {
    enabled: boolean;
    maxLiveTrials: number;
    attemptedLiveTrials: number;
    minimumLiveDelta: number;
    minimumLiveDecisionConfidence: number;
  };
};

export type TemplateOptimizerWithLiveGateArgs = Omit<TemplateOptimizerArgs, "deps"> & {
  deps: TemplateOptimizerLiveGateDeps;
  liveGate: TemplateOptimizerLiveGateConfig;
};

const DEFAULT_MAX_LIVE_TRIALS = 1;

const LIVE_JUDGE_CRITERIA = [
  "relevance to the source material",
  "actionability for Weavekit",
  "evidence grounding",
  "coverage of static DAG templates and dynamic workflows",
  "specificity of file and surface recommendations",
  "whether the optimizer complexity paid off",
];

export async function optimizeTemplateWithLiveGate(
  args: TemplateOptimizerWithLiveGateArgs,
): Promise<TemplateOptimizerWithLiveGateResult> {
  const maxLiveTrials = args.liveGate.maxLiveTrials ?? DEFAULT_MAX_LIVE_TRIALS;
  if (!args.liveGate.enabled) {
    const fixtureResult = await runFixtureOptimizer(args, args.baseline);
    return buildResult({
      args,
      fixtureResult,
      status: fixtureResult.finalIncumbent.id === args.baseline.id
        ? "keep-current-template"
        : "fixture-candidate-ready",
      maxLiveTrials,
      attemptedLiveTrials: 0,
      liveRejectedMoves: [],
    });
  }

  let incumbent = args.baseline;
  let attemptedLiveTrials = 0;
  const allIterations: TemplateOptimizerIteration[] = [];
  const fixtureRejectedMoves: string[] = [];
  const liveRejectedMoves: string[] = [];
  const leaderboard = [args.baseline];
  let latestFixtureDecision: TemplateOptimizerFixtureDecision | undefined;
  let latestLiveDecision: TemplateOptimizerLiveDecision | undefined;

  for (let liveTrialIndex = 0; liveTrialIndex < maxLiveTrials; liveTrialIndex += 1) {
    const fixtureResult = await runFixtureOptimizer(
      {
        ...args,
        compactLiveTrialTraceSummary: compactLiveRejectedMoveTrace(liveRejectedMoves),
      },
      incumbent,
    );
    allIterations.push(...fixtureResult.iterations);
    fixtureRejectedMoves.push(...fixtureResult.rejectedMoves);
    addUniqueCandidates(leaderboard, fixtureResult.leaderboard);
    latestFixtureDecision = buildFixtureDecision(fixtureResult);

    const challenger = fixtureResult.finalIncumbent;
    if (challenger.id === incumbent.id) {
      return buildResult({
        args,
        fixtureResult: {
          ...fixtureResult,
          finalIncumbent: incumbent,
          iterations: allIterations,
          rejectedMoves: fixtureRejectedMoves,
          leaderboard,
        },
        status: liveRejectedMoves.length > 0 ? "live-candidate-rejected" : "keep-current-template",
        fixtureDecision: latestFixtureDecision,
        liveDecision: latestLiveDecision,
        liveRejectedMoves,
        maxLiveTrials,
        attemptedLiveTrials,
      });
    }

    let incumbentTrial: LiveTemplateTrialResult;
    try {
      incumbentTrial = await args.deps.runIncumbentTrial({
        candidate: incumbent,
        sourceToProjectPrompt: args.liveGate.sourceToProjectPrompt,
        project: args.liveGate.project,
        mode: args.liveGate.mode,
        trialRole: "incumbent",
        liveTrialIndex,
      });
    } catch (error) {
      liveRejectedMoves.push(`Blocked live gate for ${challenger.id}: incumbent trial failed: ${stringifyError(error)}`);
      return buildResult({
        args,
        fixtureResult: {
          ...fixtureResult,
          finalIncumbent: incumbent,
          iterations: allIterations,
          rejectedMoves: fixtureRejectedMoves,
          leaderboard,
        },
        status: "live-gate-blocked",
        fixtureDecision: latestFixtureDecision,
        liveDecision: latestLiveDecision,
        liveRejectedMoves,
        maxLiveTrials,
        attemptedLiveTrials,
      });
    }
    if (incumbentTrial.status !== "passed") {
      liveRejectedMoves.push(
        `Blocked live gate for ${challenger.id}: incumbent trial ${incumbentTrial.runId} ended with status ${incumbentTrial.status}${formatOptionalError(incumbentTrial.error)}`,
      );
      return buildResult({
        args,
        fixtureResult: {
          ...fixtureResult,
          finalIncumbent: incumbent,
          iterations: allIterations,
          rejectedMoves: fixtureRejectedMoves,
          leaderboard,
        },
        status: "live-gate-blocked",
        fixtureDecision: latestFixtureDecision,
        liveDecision: latestLiveDecision,
        liveRejectedMoves,
        maxLiveTrials,
        attemptedLiveTrials,
      });
    }

    attemptedLiveTrials += 1;
    let challengerTrial: LiveTemplateTrialResult;
    try {
      challengerTrial = await args.deps.runCandidateTrial({
        candidate: challenger,
        sourceToProjectPrompt: args.liveGate.sourceToProjectPrompt,
        project: args.liveGate.project,
        mode: args.liveGate.mode,
        trialRole: "challenger",
        liveTrialIndex,
      });
    } catch (error) {
      liveRejectedMoves.push(`Rejected ${challenger.id}: challenger live trial failed: ${stringifyError(error)}`);
      continue;
    }
    if (challengerTrial.status !== "passed") {
      liveRejectedMoves.push(
        `Rejected ${challenger.id}: challenger live trial ${challengerTrial.runId} ended with status ${challengerTrial.status}${formatOptionalError(challengerTrial.error)}`,
      );
      continue;
    }

    let liveJudgment: LiveTemplateJudgment;
    try {
      liveJudgment = await args.deps.judgeLiveOutputs({
        incumbent,
        challenger,
        incumbentTrial,
        challengerTrial,
        criteria: LIVE_JUDGE_CRITERIA,
      });
    } catch (error) {
      liveRejectedMoves.push(`Rejected ${challenger.id}: live judge failed: ${stringifyError(error)}`);
      continue;
    }

    latestLiveDecision = buildLiveDecision({
      args,
      incumbent,
      challenger,
      incumbentTrial,
      challengerTrial,
      liveJudgment,
    });
    if (latestLiveDecision.adoptionDecision === "adopt-challenger") {
      incumbent = challenger;
      addUniqueCandidates(leaderboard, [challenger]);
      return buildResult({
        args,
        fixtureResult: {
          ...fixtureResult,
          finalIncumbent: incumbent,
          iterations: allIterations,
          rejectedMoves: fixtureRejectedMoves,
          leaderboard,
        },
        status: "live-candidate-ready",
        fixtureDecision: latestFixtureDecision,
        liveDecision: latestLiveDecision,
        liveRejectedMoves,
        maxLiveTrials,
        attemptedLiveTrials,
      });
    }

    liveRejectedMoves.push(buildLiveRejectedMoveSummary(challenger, latestLiveDecision, liveJudgment));
  }

  const exhaustedFixtureResult: TemplateOptimizerResult = {
    baseline: args.baseline,
    finalIncumbent: incumbent,
    iterations: allIterations,
    rejectedMoves: fixtureRejectedMoves,
    leaderboard,
  };
  return buildResult({
    args,
    fixtureResult: exhaustedFixtureResult,
    status: liveRejectedMoves.length > 0 ? "live-candidate-rejected" : "keep-current-template",
    fixtureDecision: latestFixtureDecision,
    liveDecision: latestLiveDecision,
    liveRejectedMoves,
    maxLiveTrials,
    attemptedLiveTrials,
  });
}

function runFixtureOptimizer(
  args: TemplateOptimizerWithLiveGateArgs,
  baseline: TemplateCandidate,
): Promise<TemplateOptimizerResult> {
  return optimizeTemplate({
    objective: args.objective,
    constraintsSummary: args.constraintsSummary,
    baseline,
    fixtures: args.fixtures,
    iterations: args.iterations,
    candidatesPerIteration: args.candidatesPerIteration,
    strategies: args.strategies,
    minimumDelta: args.minimumDelta,
    minimumDecisionConfidence: args.minimumDecisionConfidence,
    compactLiveTrialTraceSummary: args.compactLiveTrialTraceSummary,
    deps: args.deps.fixtureOptimizerDeps,
  });
}

function buildResult(args: {
  args: TemplateOptimizerWithLiveGateArgs;
  fixtureResult: TemplateOptimizerResult;
  status: TemplateOptimizerLiveGateStatus;
  fixtureDecision?: TemplateOptimizerFixtureDecision;
  liveDecision?: TemplateOptimizerLiveDecision;
  liveRejectedMoves: string[];
  maxLiveTrials: number;
  attemptedLiveTrials: number;
}): TemplateOptimizerWithLiveGateResult {
  return {
    ...args.fixtureResult,
    status: args.status,
    fixtureDecision: args.fixtureDecision,
    liveDecision: args.liveDecision,
    liveRejectedMoves: args.liveRejectedMoves,
    liveGate: {
      enabled: args.args.liveGate.enabled,
      maxLiveTrials: args.maxLiveTrials,
      attemptedLiveTrials: args.attemptedLiveTrials,
      minimumLiveDelta: args.args.liveGate.minimumLiveDelta,
      minimumLiveDecisionConfidence: args.args.liveGate.minimumLiveDecisionConfidence,
    },
  };
}

function buildFixtureDecision(result: TemplateOptimizerResult): TemplateOptimizerFixtureDecision | undefined {
  const replacement = findLastReplacementIteration(result.iterations);
  const latest = replacement ?? result.iterations.at(-1);
  if (!latest) {
    return undefined;
  }
  return {
    candidateId: latest.challenger.id,
    replacementDecision: latest.aggregateJudgment.replacementDecision,
    incumbentAggregateScore: latest.aggregateJudgment.incumbentAggregateScore,
    challengerAggregateScore: latest.aggregateJudgment.challengerAggregateScore,
    scoreDelta: latest.aggregateJudgment.scoreDelta,
    decisionConfidence: latest.aggregateJudgment.decisionConfidence,
  };
}

function findLastReplacementIteration(
  iterations: TemplateOptimizerIteration[],
): TemplateOptimizerIteration | undefined {
  for (let index = iterations.length - 1; index >= 0; index -= 1) {
    const iteration = iterations[index]!;
    if (iteration.replacedIncumbent) {
      return iteration;
    }
  }
  return undefined;
}

function buildLiveDecision(args: {
  args: TemplateOptimizerWithLiveGateArgs;
  incumbent: TemplateCandidate;
  challenger: TemplateCandidate;
  incumbentTrial: LiveTemplateTrialResult;
  challengerTrial: LiveTemplateTrialResult;
  liveJudgment: LiveTemplateJudgment;
}): TemplateOptimizerLiveDecision {
  const scoreDelta = args.liveJudgment.scoreDelta
    ?? args.liveJudgment.challengerScore - args.liveJudgment.incumbentScore;
  const adoptionDecision =
    args.liveJudgment.winner === "challenger" &&
    scoreDelta >= args.args.liveGate.minimumLiveDelta &&
    (args.args.liveGate.minimumLiveDecisionConfidence <= 0 ||
      args.liveJudgment.decisionConfidence >= args.args.liveGate.minimumLiveDecisionConfidence) &&
    !args.liveJudgment.criticalRegression
      ? "adopt-challenger"
      : "keep-incumbent";
  return {
    incumbentCandidateId: args.incumbent.id,
    challengerCandidateId: args.challenger.id,
    incumbentRunId: args.incumbentTrial.runId,
    challengerRunId: args.challengerTrial.runId,
    winner: args.liveJudgment.winner,
    incumbentScore: args.liveJudgment.incumbentScore,
    challengerScore: args.liveJudgment.challengerScore,
    scoreDelta,
    decisionConfidence: args.liveJudgment.decisionConfidence,
    threshold: {
      minimumLiveDelta: args.args.liveGate.minimumLiveDelta,
      minimumLiveDecisionConfidence: args.args.liveGate.minimumLiveDecisionConfidence,
    },
    adoptionDecision,
    rationale: args.liveJudgment.rationale,
    critiqueForNextChallenger: args.liveJudgment.critiqueForNextChallenger,
  };
}

function buildLiveRejectedMoveSummary(
  challenger: TemplateCandidate,
  decision: TemplateOptimizerLiveDecision,
  judgment: LiveTemplateJudgment,
): string {
  const reasons: string[] = [];
  if (decision.winner !== "challenger") {
    reasons.push(`live winner was ${decision.winner}`);
  }
  if (decision.scoreDelta < decision.threshold.minimumLiveDelta) {
    reasons.push(`live score delta ${decision.scoreDelta} is below minimum ${decision.threshold.minimumLiveDelta}`);
  }
  if (decision.decisionConfidence < decision.threshold.minimumLiveDecisionConfidence) {
    reasons.push(
      `live decision confidence ${decision.decisionConfidence} is below minimum ${decision.threshold.minimumLiveDecisionConfidence}`,
    );
  }
  if (judgment.criticalRegression) {
    reasons.push(`live critical regression${judgment.criticalRegressionReason ? `: ${judgment.criticalRegressionReason}` : ""}`);
  }
  reasons.push(decision.rationale);
  reasons.push(`critique for next challenger: ${decision.critiqueForNextChallenger}`);
  return `Rejected ${challenger.id}: ${reasons.join("; ")}`;
}

function compactLiveRejectedMoveTrace(liveRejectedMoves: string[]): string | undefined {
  if (liveRejectedMoves.length === 0) {
    return undefined;
  }
  return liveRejectedMoves
    .slice(-5)
    .map((move, index) => `${index + 1}. ${move}`)
    .join("\n");
}

function addUniqueCandidates(leaderboard: TemplateCandidate[], candidates: TemplateCandidate[]): void {
  const seen = new Set(leaderboard.map((candidate) => candidate.id));
  for (const candidate of candidates) {
    if (!seen.has(candidate.id)) {
      leaderboard.push(candidate);
      seen.add(candidate.id);
    }
  }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatOptionalError(error: string | undefined): string {
  return error ? `: ${error}` : "";
}
