import { describe, expect, it } from "vitest";
import {
  DecisionCouncilInputSchema,
  DecisionCouncilReportSchema,
  DecisionPersonaCritiqueSchema,
  DecisionRoundAssessmentSchema,
  createInitialRunState,
} from "../../src/decision-council/types.js";
import { defaultPersonaSet } from "../../src/decision-council/personas.js";

describe("decision council domain types", () => {
  it("accepts a minimal decision council input", () => {
    const parsed = DecisionCouncilInputSchema.parse({
      prompt: "Which orchestration option should we use for this workflow?",
    });

    expect(parsed.prompt).toContain("orchestration option");
    expect(parsed.constraints).toEqual([]);
  });

  it("creates initial run state with max three rounds", () => {
    const state = createInitialRunState(
      { prompt: "Evaluate this decision." },
      defaultPersonaSet,
    );

    expect(state.maxRounds).toBe(3);
    expect(state.rounds).toEqual([]);
    expect(state.personas.map((persona) => persona.id)).toEqual([
      "socratic",
      "deep-module-dry",
      "pragmatic",
      "skeptic",
    ]);
  });

  it("honors a custom maxRounds for single-round smoke runs", () => {
    const state = createInitialRunState(
      { prompt: "Evaluate this decision." },
      defaultPersonaSet,
      1,
    );

    expect(state.maxRounds).toBe(1);
  });

  it("requires decision-ready report fields", () => {
    const report = DecisionCouncilReportSchema.parse({
      recommendation: "Use the smallest reversible option.",
      rationale: ["It preserves learning speed while limiting lock-in."],
      strongestObjections: ["The reversible option may miss durability needs."],
      unresolvedQuestions: ["What persistence guarantees are required?"],
      confidence: 0.74,
      convergence: 0.8,
      nextExperiment: "Run one decision council on a real tradeoff.",
      finalReportMarkdown: "# Decision Council Report\n\nUse the smallest reversible option.",
      failedPersonas: [],
    });

    expect(report.confidence).toBeGreaterThan(0.7);
    expect(report.finalReportMarkdown).toContain("# Decision Council Report");
  });

  it("requires normalized persona critiques to include a compact overall summary", () => {
    const critique = DecisionPersonaCritiqueSchema.parse({
      personaId: "pragmatic",
      overallSummary: "Pragmatic persona recommends a minimal validation spike before choosing.",
      summary: "The decision should be validated with the smallest useful experiment.",
      claims: ["The smallest useful experiment is enough for v0."],
      risks: ["Premature framework adoption can obscure the core product risk."],
      questions: ["What measurable problem justifies the choice?"],
      recommendations: ["Run a focused spike before expanding the orchestration layer."],
    });

    expect(critique.overallSummary).toContain("minimal validation spike");
  });

  it("normalizes a null next round brief from BAML into an omitted brief", () => {
    const assessment = DecisionRoundAssessmentSchema.parse({
      roundNumber: 3,
      consensus: "Run a Mastra-first spike with fallback criteria.",
      disagreements: ["How long the spike should take."],
      confidence: 0.84,
      convergence: 0.78,
      shouldContinue: false,
      diminishingReturns: true,
      nextRoundBrief: null,
    });

    expect(assessment.nextRoundBrief).toBeUndefined();
  });
});
