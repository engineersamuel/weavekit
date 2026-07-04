import { describe, expect, it, vi } from "vitest";
import type {
  AggregateTemplateJudgment,
  TemplateCandidate,
  TemplateFixtureJudgment,
  TemplateOptimizationFixture,
} from "../../../src/generated/baml_client/index.js";
import { optimizeTemplate } from "../../../src/macro-workflow/templateOptimizer/engine.js";

const baseline = candidate("baseline");
const challenger = candidate("challenger-1");
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

describe("template optimizer engine", () => {
  it("replaces incumbent only when aggregate delta clears threshold and no critical regression exists", async () => {
    const result = await optimizeTemplate({
      objective,
      constraintsSummary,
      baseline,
      fixtures: [fixture],
      iterations: 1,
      candidatesPerIteration: 1,
      strategies: ["coverage-focused"],
      minimumDelta: 0.1,
      minimumDecisionConfidence: 0.6,
      deps: {
        generateChallenger: vi.fn(async () => challenger),
        judgeFixture: vi.fn(async () =>
          judgment({
            incumbentScore: 0.5,
            challengerScore: 0.7,
            criticalRegression: false,
            winner: "challenger",
          }),
        ),
        aggregateJudgments: vi.fn(async () =>
          aggregate({
            scoreDelta: 0.2,
            criticalRegressionCount: 0,
            replacementDecision: "replace-with-challenger",
            decisionConfidence: 0.8,
          }),
        ),
      },
    });

    expect(result.finalIncumbent.id).toBe("challenger-1");
    expect(result.iterations).toHaveLength(1);
    expect(result.iterations[0]?.replacedIncumbent).toBe(true);
  });

  it("keeps incumbent when critical regression is present", async () => {
    const result = await optimizeTemplate({
      objective,
      constraintsSummary,
      baseline,
      fixtures: [fixture],
      iterations: 1,
      candidatesPerIteration: 1,
      strategies: ["coverage-focused"],
      minimumDelta: 0.1,
      minimumDecisionConfidence: 0.6,
      deps: {
        generateChallenger: vi.fn(async () => challenger),
        judgeFixture: vi.fn(async () =>
          judgment({
            incumbentScore: 0.5,
            challengerScore: 0.7,
            criticalRegression: true,
            criticalRegressionReason: "Forced no-fit plan violates advisory mode.",
            winner: "challenger",
          }),
        ),
        aggregateJudgments: vi.fn(async () =>
          aggregate({
            scoreDelta: 0.2,
            criticalRegressionCount: 1,
            replacementDecision: "keep-incumbent",
            rejectedMoveSummary: "forced no-fit plan",
            decisionConfidence: 0.8,
          }),
        ),
      },
    });

    expect(result.finalIncumbent.id).toBe("baseline");
    expect(result.rejectedMoves).toContain("forced no-fit plan");
  });

  it("keeps incumbent when replacement delta is below the minimum threshold", async () => {
    const result = await optimizeTemplate({
      objective,
      constraintsSummary,
      baseline,
      fixtures: [fixture],
      iterations: 1,
      candidatesPerIteration: 1,
      strategies: ["coverage-focused"],
      minimumDelta: 0.25,
      minimumDecisionConfidence: 0.6,
      deps: {
        generateChallenger: vi.fn(async () => challenger),
        judgeFixture: vi.fn(async () =>
          judgment({
            incumbentScore: 0.5,
            challengerScore: 0.7,
            criticalRegression: false,
            winner: "challenger",
          }),
        ),
        aggregateJudgments: vi.fn(async () =>
          aggregate({
            scoreDelta: 0.2,
            criticalRegressionCount: 0,
            replacementDecision: "replace-with-challenger",
            decisionConfidence: 0.8,
          }),
        ),
      },
    });

    expect(result.finalIncumbent.id).toBe("baseline");
    expect(result.rejectedMoves).toHaveLength(1);
    expect(result.rejectedMoves[0]).toContain("challenger-1");
    expect(result.rejectedMoves[0]).toContain("below minimum delta");
  });

  it("passes integration contract fields through to optimizer dependencies", async () => {
    const generateChallenger = vi.fn(async () => challenger);
    const judgeFixture = vi.fn(async () =>
      judgment({
        incumbentScore: 0.5,
        challengerScore: 0.7,
        criticalRegression: false,
        winner: "challenger",
      }),
    );
    const aggregateJudgments = vi.fn(async () =>
      aggregate({
        scoreDelta: 0.2,
        criticalRegressionCount: 0,
        replacementDecision: "replace-with-challenger",
        decisionConfidence: 0.8,
      }),
    );

    await optimizeTemplate({
      objective,
      constraintsSummary,
      baseline,
      fixtures: [fixture],
      iterations: 1,
      candidatesPerIteration: 1,
      strategies: ["coverage-focused"],
      minimumDelta: 0.1,
      minimumDecisionConfidence: 0.6,
      deps: {
        generateChallenger,
        judgeFixture,
        aggregateJudgments,
      },
    });

    expect(generateChallenger).toHaveBeenCalledWith(
      expect.objectContaining({
        objective,
        constraintsSummary,
        incumbent: baseline,
        compactTraceSummary: "No rejected moves yet.",
        strategy: "coverage-focused",
        fixtures: [fixture],
      }),
    );
    expect(judgeFixture).toHaveBeenCalledWith(
      expect.objectContaining({
        objective,
        constraintsSummary,
      }),
    );
    expect(aggregateJudgments).toHaveBeenCalledWith(
      expect.objectContaining({
        minimumDelta: 0.1,
        minimumDecisionConfidence: 0.6,
      }),
    );
  });
});

function candidate(id: string): TemplateCandidate {
  return {
    id,
    templateId: "source-to-project",
    mode: "advisory",
    summary: `${id} summary`,
    sharedInitialNodes: [
      {
        id: "review",
        kind: "review",
        harness: "source-to-project",
        title: "Final recommendation review",
        prompt: "Review the final recommendation.",
        dependsOn: [],
        gates: [],
        writeMode: "none",
        replanPolicy: "never",
      },
    ],
    modePolicies: [
      {
        mode: "advisory",
        enabledForOptimization: true,
        expansionCases: [],
        constraints: ["Do not edit files."],
      },
    ],
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
  const { winner, ...rest } = overrides;
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
    ...rest,
    winner,
  };
}

function aggregate(overrides: Partial<AggregateTemplateJudgment>): AggregateTemplateJudgment {
  return {
    incumbentId: baseline.id,
    challengerId: challenger.id,
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
