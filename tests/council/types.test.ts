import { describe, expect, it } from "vitest";
import {
  CouncilInputSchema,
  CouncilReportSchema,
  PersonaCritiqueSchema,
  createInitialRunState,
} from "../../src/council/types.js";
import { defaultPersonaSet } from "../../src/council/personas.js";

describe("council domain types", () => {
  it("accepts a minimal council input", () => {
    const parsed = CouncilInputSchema.parse({
      prompt: "Should we use Flue for this workflow?",
    });

    expect(parsed.prompt).toContain("Flue");
    expect(parsed.constraints).toEqual([]);
  });

  it("creates initial run state with max three rounds", () => {
    const state = createInitialRunState(
      { prompt: "Evaluate this architecture." },
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

  it("requires decision-ready report fields", () => {
    const report = CouncilReportSchema.parse({
      recommendation: "Use Flue for v0.",
      rationale: ["It matches the workflow-first shape."],
      strongestObjections: ["Flue API churn is possible."],
      unresolvedQuestions: ["How stable is the Copilot SDK package?"],
      confidence: 0.74,
      convergence: 0.8,
      nextExperiment: "Build one council run against a real design question.",
      finalReportMarkdown: "# Design Council Report\n\nUse Flue for v0.",
      failedPersonas: [],
    });

    expect(report.confidence).toBeGreaterThan(0.7);
    expect(report.finalReportMarkdown).toContain("# Design Council Report");
  });

  it("requires normalized persona critiques to include a compact overall summary", () => {
    const critique = PersonaCritiqueSchema.parse({
      personaId: "pragmatic",
      overallSummary: "Pragmatic persona recommends a minimal validation spike before adopting orchestration layers.",
      summary: "The design should prove the council pattern before committing to Flue and BAML.",
      claims: ["The smallest useful experiment is enough for v0."],
      risks: ["Premature framework adoption can obscure the core product risk."],
      questions: ["What measurable problem justifies Flue?"],
      recommendations: ["Run a two-persona spike before expanding the orchestration layer."],
    });

    expect(critique.overallSummary).toContain("minimal validation spike");
  });
});
