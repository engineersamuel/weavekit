import { describe, expect, it } from "vitest";
import { createTemplateOptimizerBamlAdapters } from "../../../src/macro-workflow/templateOptimizer/bamlAdapters.js";
import type {
  AggregateTemplateJudgment,
  TemplateCandidate,
  TemplateFixtureJudgment,
  TemplateOptimizationFixture,
} from "../../../src/generated/baml_client/index.js";

describe("template optimizer BAML adapter seam", () => {
  it("forwards optimizer dependency calls to generated BAML functions positionally", async () => {
    const incumbent = candidate("incumbent");
    const challenger = candidate("challenger");
    const fixture: TemplateOptimizationFixture = {
      id: "strong-fit",
      mode: "advisory",
      scenarioSummary: "Strong source/project fit.",
      sourceLessons: ["Prefer focused workflows."],
      projectConstraints: ["Keep advisory runs read-only."],
      opportunities: ["Improve report completeness."],
      idealFeatures: ["Clear terminal report."],
      mustPreserve: ["No implementation nodes."],
      failureModes: ["Skipping report output."],
    };
    const fixtureJudgment: TemplateFixtureJudgment = {
      fixtureId: fixture.id,
      incumbentScore: 0.6,
      challengerScore: 0.72,
      criteriaScores: [],
      criticalRegression: false,
      winner: "challenger",
      rationale: "Better coverage.",
      critiqueForNextChallenger: "Keep output concise.",
      fixtureGapNotes: [],
      decisionConfidence: 0.8,
    };
    const aggregateJudgment: AggregateTemplateJudgment = {
      incumbentId: incumbent.id,
      challengerId: challenger.id,
      incumbentAggregateScore: 0.6,
      challengerAggregateScore: 0.72,
      scoreDelta: 0.12,
      criticalRegressionCount: 0,
      replacementDecision: "replace-with-challenger",
      rationale: "Challenger is better.",
      decisionConfidence: 0.9,
    };
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const adapters = createTemplateOptimizerBamlAdapters({
      async GenerateTemplateChallenger(...args: unknown[]) {
        calls.push({ method: "GenerateTemplateChallenger", args });
        return challenger;
      },
      async JudgeTemplateFixture(...args: unknown[]) {
        calls.push({ method: "JudgeTemplateFixture", args });
        return fixtureJudgment;
      },
      async AggregateTemplateJudgments(...args: unknown[]) {
        calls.push({ method: "AggregateTemplateJudgments", args });
        return aggregateJudgment;
      },
    });

    await expect(
      adapters.generateChallenger({
        objective: "Optimize source-to-project advisory Static template quality.",
        constraintsSummary: "mode: advisory",
        baseline: candidate("baseline"),
        incumbent,
        fixtures: [fixture],
        iterationIndex: 2,
        candidateIndex: 1,
        strategy: "coverage-focused",
        compactTraceSummary: "No rejected moves yet.",
        compactLiveTrialTraceSummary: "Rejected challenger-a: live score delta -1.4.",
        leaderboard: [incumbent],
      }),
    ).resolves.toBe(challenger);
    await expect(
      adapters.judgeFixture({
        objective: "Optimize source-to-project advisory Static template quality.",
        constraintsSummary: "mode: advisory",
        fixture,
        incumbent,
        challenger,
        iterationIndex: 2,
        candidateIndex: 1,
        strategy: "coverage-focused",
      }),
    ).resolves.toBe(fixtureJudgment);
    await expect(
      adapters.aggregateJudgments({
        fixtures: [fixture],
        incumbent,
        challenger,
        fixtureJudgments: [fixtureJudgment],
        iterationIndex: 2,
        candidateIndex: 1,
        strategy: "coverage-focused",
        minimumDelta: 0.03,
        minimumDecisionConfidence: 0.7,
      }),
    ).resolves.toBe(aggregateJudgment);

    expect(calls).toEqual([
      {
        method: "GenerateTemplateChallenger",
        args: [
          "Optimize source-to-project advisory Static template quality.",
          "mode: advisory",
          incumbent,
          "No rejected moves yet.\n\nLive trial rejection trace:\nRejected challenger-a: live score delta -1.4.",
          "coverage-focused",
          [fixture],
          { client: "CopilotProxyGpt55", onTick: expect.any(Function) },
        ],
      },
      {
        method: "JudgeTemplateFixture",
        args: [
          "Optimize source-to-project advisory Static template quality.",
          "mode: advisory",
          fixture,
          incumbent,
          challenger,
        ],
      },
      {
        method: "AggregateTemplateJudgments",
        args: [incumbent, challenger, [fixtureJudgment], 0.03, 0.7],
      },
    ]);
  });

  it("retries transient BAML provider failures", async () => {
    const challenger = candidate("challenger");
    let attempts = 0;
    const adapters = createTemplateOptimizerBamlAdapters(
      {
        async GenerateTemplateChallenger() {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("Request failed with status code: 502 Bad Gateway");
          }
          return challenger;
        },
        async JudgeTemplateFixture() {
          throw new Error("not used");
        },
        async AggregateTemplateJudgments() {
          throw new Error("not used");
        },
      },
      { retryDelayMs: 0 },
    );

    await expect(
      adapters.generateChallenger({
        objective: "Optimize",
        constraintsSummary: "constraints",
        baseline: candidate("baseline"),
        incumbent: candidate("incumbent"),
        fixtures: [],
        iterationIndex: 0,
        candidateIndex: 0,
        strategy: "coverage-focused",
        compactTraceSummary: "No rejected moves yet.",
        leaderboard: [],
      }),
    ).resolves.toBe(challenger);
    expect(attempts).toBe(2);
  });
});

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
