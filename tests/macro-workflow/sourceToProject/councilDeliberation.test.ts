import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DecisionCouncilInput,
  DecisionCouncilReport,
  DecisionCouncilRunState,
} from "../../../src/decision-council/types.js";
import type { RunDecisionCouncilOptions } from "../../../src/decision-council/runner.js";
import type { OpportunityCouncilReview } from "../../../src/generated/baml_client/index.js";
import type { OpportunityAcceptance } from "../../../src/macro-workflow/sourceToProject/harnesses.js";

const mocks = vi.hoisted(() => ({
  runDecisionCouncil:
    vi.fn<
      (
        input: DecisionCouncilInput,
        options?: RunDecisionCouncilOptions,
      ) => Promise<DecisionCouncilReport>
    >(),
}));

vi.mock("../../../src/decision-council/runner.js", () => ({
  runDecisionCouncil: mocks.runDecisionCouncil,
}));

const { buildCouncilDeliberationInput, runCouncilDeliberation } =
  await import("../../../src/macro-workflow/sourceToProject/councilDeliberation.js");

function makeReview(overrides: Partial<OpportunityCouncilReview> = {}): OpportunityCouncilReview {
  return {
    opportunities: [],
    nonApplicableLessons: [],
    bundles: [],
    rankingRationale: "Ranked by applicability and risk.",
    ...overrides,
  };
}

function makeAcceptance(overrides: Partial<OpportunityAcceptance> = {}): OpportunityAcceptance {
  return {
    id: "opp-1",
    title: "Add retry logic",
    accepted: true,
    reason: "Clears all thresholds.",
    acceptanceAverage: 0.9,
    scores: {
      applicability: 0.9,
      applicabilityReasoning: "Directly applicable.",
      impact: 0.8,
      impactReasoning: "High value.",
      confidence: 0.85,
      confidenceReasoning: "Well corroborated.",
      risk: 0.2,
      riskReasoning: "Low risk.",
    },
    opportunity: {
      id: "opp-1",
      title: "Add retry logic",
      lesson: "Retries reduce transient failures.",
      projectChange: "Add retry wrapper.",
      changeSurface: "src/http",
      practiceIds: [],
      behaviorIds: [],
      targetLayers: [],
      proofIds: [],
      score: {
        applicability: 0.9,
        applicabilityReasoning: "Directly applicable.",
        impact: 0.8,
        impactReasoning: "High value.",
        confidence: 0.85,
        confidenceReasoning: "Well corroborated.",
        implementationCost: 0.3,
        implementationCostReasoning: "Small change.",
        risk: 0.2,
        riskReasoning: "Low risk.",
      },
      evidence: [],
      speculative: false,
    },
    ...overrides,
  };
}

const thresholds = {
  minApplicability: 0.7,
  minConfidence: 0.65,
  minImpact: 0.5,
  minAcceptanceAverage: 0.85,
  maxRisk: 0.8,
};

describe("buildCouncilDeliberationInput", () => {
  it("includes objective, ranking rationale, thresholds, and accepted/rejected opportunities", () => {
    const input = buildCouncilDeliberationInput({
      objective: "Improve reliability.",
      review: makeReview(),
      acceptances: [
        makeAcceptance(),
        makeAcceptance({
          id: "opp-2",
          title: "Add caching",
          accepted: false,
          reason: "Too risky.",
        }),
      ],
      thresholds,
    });

    expect(input.prompt).toContain("deterministic gate");
    expect(input.context.some((line) => line.includes("Improve reliability."))).toBe(true);
    expect(input.context.some((line) => line.includes("Ranked by applicability and risk."))).toBe(
      true,
    );
    expect(input.context.some((line) => line.includes("minApplicability=0.7"))).toBe(true);
    expect(input.context.some((line) => line.includes("Add retry logic"))).toBe(true);
    expect(input.context.some((line) => line.includes("Add caching"))).toBe(true);
    expect(input.constraints.length).toBeGreaterThan(0);
  });

  it("omits the objective line when no objective is provided", () => {
    const input = buildCouncilDeliberationInput({
      review: makeReview(),
      acceptances: [makeAcceptance()],
      thresholds,
    });

    expect(input.context.some((line) => line.startsWith("Original objective"))).toBe(false);
  });

  it("reports no accepted/rejected opportunities distinctly when all fall on one side", () => {
    const input = buildCouncilDeliberationInput({
      review: makeReview(),
      acceptances: [makeAcceptance({ accepted: true })],
      thresholds,
    });

    expect(input.context.some((line) => line.includes("No opportunities were accepted"))).toBe(
      false,
    );
    expect(input.context.some((line) => line.startsWith("Rejected opportunities"))).toBe(false);
  });
});

describe("runCouncilDeliberation", () => {
  beforeEach(() => {
    mocks.runDecisionCouncil.mockReset();
  });

  it("shapes a successful run into a completed result with real selected personas", async () => {
    const report: DecisionCouncilReport = {
      recommendation: "Proceed with the accepted opportunities.",
      rationale: ["Evidence is strong."],
      strongestObjections: ["Risk of regression in edge cases."],
      unresolvedQuestions: [],
      confidence: 0.8,
      convergence: 0.75,
      nextExperiment: "Ship behind a flag and monitor error rates.",
      finalReportMarkdown: "# Report\nProceed.",
      failedPersonas: [],
    };
    const runState: DecisionCouncilRunState = {
      input: { prompt: "test", context: [], constraints: [] },
      personas: [
        {
          id: "socratic",
          name: "Socratic",
          description: "Questions assumptions.",
          prompt: "Be Socratic.",
          role: "reviewer",
          archetype: "critic",
          tags: [],
          useWhen: [],
          avoidWhen: [],
        },
        {
          id: "pragmatic",
          name: "Pragmatic",
          description: "Focuses on delivery.",
          prompt: "Be pragmatic.",
          role: "advisor",
          archetype: "synthesist",
          tags: [],
          useWhen: [],
          avoidWhen: [],
        },
      ],
      maxRounds: 1,
      rounds: [
        {
          brief: { roundNumber: 1, prompt: "Debate the opportunities.", focus: "Acceptance gate" },
          personaSelection: {
            personaIds: ["socratic", "pragmatic"],
            rationale: "Need critique and delivery viewpoints.",
          },
          rawResults: [],
          critiques: [],
          failures: [],
          assessment: {
            roundNumber: 1,
            consensus: "Agreed.",
            disagreements: [],
            confidence: 0.8,
            convergence: 0.75,
            shouldContinue: false,
            diminishingReturns: false,
          },
        },
      ],
      finalReport: report,
      stopReason: "consensus",
    };

    mocks.runDecisionCouncil.mockImplementation(async (_input, options) => {
      options?.onRunState?.(runState);
      return report;
    });

    const result = await runCouncilDeliberation({
      prompt: "Should we proceed?",
      context: [],
      constraints: [],
    });

    expect(mocks.runDecisionCouncil).toHaveBeenCalledTimes(1);
    const [, calledOptions] = mocks.runDecisionCouncil.mock.calls[0]!;
    expect(calledOptions?.maxRounds).toBe(1);
    expect(calledOptions?.deps?.writeArtifacts).toBe(false);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("expected completed result");
    expect(result.personas).toEqual([
      { id: "socratic", name: "Socratic", archetype: "critic" },
      { id: "pragmatic", name: "Pragmatic", archetype: "synthesist" },
    ]);
    expect(result.personaSelectionRationale).toBe("Need critique and delivery viewpoints.");
    expect(result.recommendation).toBe(report.recommendation);
    expect(result.finalReportMarkdown).toBe(report.finalReportMarkdown);
    expect(result.model).toBeTruthy();
  });

  it("passes a custom maxRounds through to runDecisionCouncil", async () => {
    mocks.runDecisionCouncil.mockImplementation(async (_input, options) => {
      options?.onRunState?.({
        input: { prompt: "test", context: [], constraints: [] },
        personas: [],
        maxRounds: options?.maxRounds ?? 1,
        rounds: [],
      } as unknown as DecisionCouncilRunState);
      return {
        recommendation: "r",
        rationale: [],
        strongestObjections: [],
        unresolvedQuestions: [],
        confidence: 0.5,
        convergence: 0.5,
        nextExperiment: "n",
        finalReportMarkdown: "m",
        failedPersonas: [],
      };
    });

    await runCouncilDeliberation(
      { prompt: "Should we proceed?", context: [], constraints: [] },
      { maxRounds: 3 },
    );

    const [, calledOptions] = mocks.runDecisionCouncil.mock.calls[0]!;
    expect(calledOptions?.maxRounds).toBe(3);
  });

  it("returns a failed result instead of throwing when the council run rejects", async () => {
    mocks.runDecisionCouncil.mockRejectedValue(new Error("persona session timed out"));

    const result = await runCouncilDeliberation({
      prompt: "Should we proceed?",
      context: [],
      constraints: [],
    });

    expect(result).toEqual({ status: "failed", error: "persona session timed out" });
  });
});
