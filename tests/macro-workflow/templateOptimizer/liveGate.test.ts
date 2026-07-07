import { describe, expect, it, vi } from "vitest";
import type {
  AggregateTemplateJudgment,
  TemplateCandidate,
  TemplateFixtureJudgment,
  TemplateOptimizationFixture,
} from "../../../src/generated/baml_client/index.js";
import {
  optimizeTemplateWithLiveGate,
  type LiveTemplateJudgment,
  type LiveTemplateTrialResult,
  type TemplateOptimizerLiveGateDeps,
} from "../../../src/macro-workflow/templateOptimizer/liveGate.js";

const baseline = candidate("baseline");
const objective = "Improve source-to-project advisory coverage without adding implementation.";
const constraintsSummary = "Advisory mode must not write files and must preserve final review.";
const fixture: TemplateOptimizationFixture = {
  id: "strong-fit",
  mode: "advisory",
  scenarioSummary: "A source-to-project run with clear advisory opportunities.",
  sourceLessons: ["Keep research and recommendation work distinct."],
  projectConstraints: ["Advisory mode must not edit files."],
  opportunities: ["Improve final recommendation specificity."],
  idealFeatures: ["Keeps final review in the workflow."],
  mustPreserve: ["No implementation node in advisory mode."],
  failureModes: ["Adds a forced no-fit plan."],
};

describe("template optimizer live gate", () => {
  it("rejects a fixture winner that loses live judging and keeps the incumbent", async () => {
    const challenger = candidate("challenger-live-loser");
    const deps = liveGateDeps({
      challengers: [challenger],
      liveJudgments: [
        liveJudgment({
          incumbentScore: 8.0,
          challengerScore: 6.6,
          winner: "incumbent",
          rationale: "The optimized trial missed static DAG and dynamic workflow coverage.",
          critiqueForNextChallenger: "Restore static DAG and dynamic workflow coverage.",
        }),
      ],
    });

    const result = await optimizeTemplateWithLiveGate(baseArgs(deps));

    expect(result.status).toBe("live-candidate-rejected");
    expect(result.finalIncumbent.id).toBe("baseline");
    expect(result.liveDecision).toMatchObject({
      incumbentScore: 8.0,
      challengerScore: 6.6,
      scoreDelta: -1.4000000000000004,
      adoptionDecision: "keep-incumbent",
    });
    expect(result.liveRejectedMoves[0]).toContain("Restore static DAG and dynamic workflow coverage.");
  });

  it("promotes a fixture winner only after it clears live thresholds", async () => {
    const challenger = candidate("challenger-live-winner");
    const deps = liveGateDeps({
      challengers: [challenger],
      liveJudgments: [
        liveJudgment({
          incumbentScore: 8.0,
          challengerScore: 8.4,
          winner: "challenger",
          decisionConfidence: 0.9,
        }),
      ],
    });

    const result = await optimizeTemplateWithLiveGate(baseArgs(deps));

    expect(result.status).toBe("live-candidate-ready");
    expect(result.finalIncumbent.id).toBe("challenger-live-winner");
    expect(result.liveDecision).toMatchObject({
      adoptionDecision: "adopt-challenger",
      incumbentRunId: "incumbent-run-0",
      challengerRunId: "challenger-run-0",
    });
  });

  it("rejects a challenger when the challenger live trial fails", async () => {
    const challenger = candidate("challenger-failed-run");
    const deps = liveGateDeps({
      challengers: [challenger],
      candidateTrials: [
        {
          runId: "challenger-run-0",
          status: "failed",
          output: "",
          error: "workflow node failed",
        },
      ],
    });

    const result = await optimizeTemplateWithLiveGate(baseArgs(deps));

    expect(result.status).toBe("live-candidate-rejected");
    expect(result.finalIncumbent.id).toBe("baseline");
    expect(result.liveRejectedMoves[0]).toContain("challenger live trial challenger-run-0 ended with status failed");
    expect(deps.judgeLiveOutputs).not.toHaveBeenCalled();
  });

  it("blocks adoption when the incumbent live trial cannot produce a passed baseline", async () => {
    const challenger = candidate("challenger-without-baseline");
    const deps = liveGateDeps({
      challengers: [challenger],
      incumbentTrials: [
        {
          runId: "incumbent-run-0",
          status: "failed",
          output: "",
          error: "baseline workflow failed",
        },
      ],
    });

    const result = await optimizeTemplateWithLiveGate(baseArgs(deps));

    expect(result.status).toBe("live-gate-blocked");
    expect(result.finalIncumbent.id).toBe("baseline");
    expect(result.liveRejectedMoves[0]).toContain("incumbent trial incumbent-run-0 ended with status failed");
    expect(deps.runCandidateTrial).not.toHaveBeenCalled();
  });

  it("feeds live rejection critique into the next challenger generation attempt", async () => {
    const first = candidate("challenger-live-loser");
    const second = candidate("challenger-after-live-critique");
    const deps = liveGateDeps({
      challengers: [first, second],
      liveJudgments: [
        liveJudgment({
          incumbentScore: 8.0,
          challengerScore: 6.6,
          winner: "incumbent",
          critiqueForNextChallenger: "Recover evidence grounding and workflow coverage.",
        }),
        liveJudgment({
          incumbentScore: 8.0,
          challengerScore: 8.5,
          winner: "challenger",
        }),
      ],
    });

    const result = await optimizeTemplateWithLiveGate({
      ...baseArgs(deps),
      liveGate: {
        ...baseArgs(deps).liveGate,
        maxLiveTrials: 2,
      },
    });

    expect(result.status).toBe("live-candidate-ready");
    expect(result.finalIncumbent.id).toBe("challenger-after-live-critique");
    expect(deps.fixtureOptimizerDeps.generateChallenger).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        compactLiveTrialTraceSummary: expect.stringContaining("Recover evidence grounding and workflow coverage."),
      }),
    );
  });
});

function baseArgs(deps: TemplateOptimizerLiveGateDeps) {
  return {
    objective,
    constraintsSummary,
    baseline,
    fixtures: [fixture],
    iterations: 1,
    candidatesPerIteration: 1,
    strategies: ["coverage-focused"],
    minimumDelta: 0.1,
    minimumDecisionConfidence: 0.6,
    deps,
    liveGate: {
      enabled: true,
      maxLiveTrials: 1,
      minimumLiveDelta: 0.1,
      minimumLiveDecisionConfidence: 0.6,
      sourceToProjectPrompt: "Adapt a source article to Weavekit.",
      project: "weavekit",
      mode: "advisory" as const,
    },
  };
}

function liveGateDeps(args: {
  challengers: TemplateCandidate[];
  incumbentTrials?: LiveTemplateTrialResult[];
  candidateTrials?: LiveTemplateTrialResult[];
  liveJudgments?: LiveTemplateJudgment[];
}): TemplateOptimizerLiveGateDeps {
  const challengers = [...args.challengers];
  const incumbentTrials = args.incumbentTrials ?? [];
  const candidateTrials = args.candidateTrials ?? [];
  const liveJudgments = args.liveJudgments ?? [];
  return {
    fixtureOptimizerDeps: {
      generateChallenger: vi.fn(async () => challengers.shift() ?? candidate("unexpected-challenger")),
      judgeFixture: vi.fn(async () => judgment({ winner: "challenger" })),
      aggregateJudgments: vi.fn(async (aggregateArgs) =>
        aggregate({
          incumbentId: aggregateArgs.incumbent.id,
          challengerId: aggregateArgs.challenger.id,
          replacementDecision: "replace-with-challenger",
        }),
      ),
    },
    runIncumbentTrial: vi.fn(async (trialArgs) =>
      incumbentTrials.shift() ?? {
        runId: `incumbent-run-${trialArgs.liveTrialIndex}`,
        status: "passed",
        output: "incumbent output",
      },
    ),
    runCandidateTrial: vi.fn(async (trialArgs) =>
      candidateTrials.shift() ?? {
        runId: `challenger-run-${trialArgs.liveTrialIndex}`,
        status: "passed",
        output: "challenger output",
      },
    ),
    judgeLiveOutputs: vi.fn(async () => liveJudgments.shift() ?? liveJudgment({ winner: "challenger" })),
  };
}

function candidate(id: string): TemplateCandidate {
  return {
    id,
    templateId: "source-to-project",
    mode: "advisory",
    summary: `${id} summary`,
    sharedInitialNodes: [],
    modePolicies: [],
    changedInitialDag: false,
    changedExpansionPolicy: false,
    requiresAutonomousPrReview: false,
    rationale: `${id} rationale`,
    suggestedCodeTouchpoints: [],
    adoptionTasks: [],
  };
}

function judgment(
  overrides: Partial<TemplateFixtureJudgment> & Pick<TemplateFixtureJudgment, "winner">,
): TemplateFixtureJudgment {
  return {
    fixtureId: fixture.id,
    incumbentScore: 0.5,
    challengerScore: 0.7,
    criteriaScores: [{ criterion: "coverage", score: 0.7, rationale: "Better coverage." }],
    criticalRegression: false,
    rationale: "Challenger improves the fixture.",
    critiqueForNextChallenger: "Preserve advisory constraints.",
    fixtureGapNotes: [],
    decisionConfidence: 0.8,
    ...overrides,
  };
}

function aggregate(overrides: Partial<AggregateTemplateJudgment>): AggregateTemplateJudgment {
  return {
    incumbentId: baseline.id,
    challengerId: "challenger",
    incumbentAggregateScore: 0.5,
    challengerAggregateScore: 0.7,
    scoreDelta: 0.2,
    criticalRegressionCount: 0,
    replacementDecision: "replace-with-challenger",
    rationale: "Challenger improves aggregate score.",
    decisionConfidence: 0.8,
    ...overrides,
  };
}

function liveJudgment(overrides: Partial<LiveTemplateJudgment>): LiveTemplateJudgment {
  const incumbentScore = overrides.incumbentScore ?? 8.0;
  const challengerScore = overrides.challengerScore ?? 8.4;
  return {
    incumbentScore,
    challengerScore,
    scoreDelta: challengerScore - incumbentScore,
    winner: "challenger",
    decisionConfidence: 0.8,
    criticalRegression: false,
    rationale: "The challenger improves real source-to-project output.",
    critiqueForNextChallenger: "Keep the useful live improvements.",
    ...overrides,
  };
}
