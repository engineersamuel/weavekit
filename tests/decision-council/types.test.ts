import { describe, expect, it } from "vitest";
import {
  DecisionCouncilInputSchema,
  DecisionCouncilRoundSchema,
  DecisionCouncilReportSchema,
  DecisionPersonaCritiqueSchema,
  DecisionPersonaSelectionSchema,
  DecisionRoundAssessmentSchema,
  createInitialRunState,
} from "../../src/decision-council/types.js";
import { listPersonas } from "../../src/personas/index.js";

function testPersonas() {
  const ids = ["socratic", "deep-module-dry", "pragmatic", "skeptic"];
  const byId = new Map(listPersonas().map((persona) => [persona.id, persona]));
  return ids.map((id) => byId.get(id)!);
}

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
      { name: "test", personas: testPersonas() },
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
      { name: "test", personas: testPersonas() },
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

  it("normalizes null clarifying question choices from BAML into omitted choices", () => {
    const assessment = DecisionRoundAssessmentSchema.parse({
      roundNumber: 2,
      consensus: "Need user input on scope.",
      disagreements: ["scope"],
      confidence: 0.5,
      convergence: 0.4,
      shouldContinue: true,
      diminishingReturns: false,
      needsHumanInput: true,
      clarifyingQuestions: [
        { id: "q1", text: "What is the budget ceiling?", choices: null },
      ],
    });

    expect(assessment.clarifyingQuestions?.[0]).toEqual({
      id: "q1",
      text: "What is the budget ceiling?",
    });
  });

  it("requires round persona selections to include at least two ids and rationale", () => {
    const selection = DecisionPersonaSelectionSchema.parse({
      personaIds: ["socratic", "pragmatic"],
      rationale: "Need both pressure-testing and delivery focus.",
    });
    expect(selection.personaIds).toEqual(["socratic", "pragmatic"]);

    expect(() =>
      DecisionCouncilRoundSchema.parse({
        brief: { roundNumber: 1, prompt: "Question", focus: "Initial critique" },
        personaSelection: { personaIds: ["socratic"], rationale: "Too few." },
        rawResults: [],
        critiques: [],
        failures: [],
        assessment: {
          roundNumber: 1,
          consensus: "Continue",
          disagreements: [],
          confidence: 0.5,
          convergence: 0.4,
          shouldContinue: true,
          diminishingReturns: false,
          nextRoundBrief: "Focus on implementation risks.",
        },
      }),
    ).toThrow();
  });

  it("omits needsHumanInput and clarifyingQuestions when the assessment does not include them", () => {
    const assessment = DecisionRoundAssessmentSchema.parse({
      roundNumber: 1,
      consensus: "Lean yes.",
      disagreements: [],
      confidence: 0.6,
      convergence: 0.5,
      shouldContinue: true,
      diminishingReturns: false,
    });

    expect(assessment.needsHumanInput).toBeUndefined();
    expect(assessment.clarifyingQuestions).toBeUndefined();
  });

  it("preserves emitted clarifying questions", () => {
    const assessment = DecisionRoundAssessmentSchema.parse({
      roundNumber: 2,
      consensus: "Need user input on scope.",
      disagreements: ["scope"],
      confidence: 0.5,
      convergence: 0.4,
      shouldContinue: true,
      diminishingReturns: false,
      needsHumanInput: true,
      clarifyingQuestions: [
        { id: "q1", text: "What is the budget ceiling?", importance: "blocking" },
        { id: "q2", text: "On-prem or cloud?", choices: ["on-prem", "cloud"] },
      ],
    });

    expect(assessment.needsHumanInput).toBe(true);
    expect(assessment.clarifyingQuestions).toHaveLength(2);
    expect(assessment.clarifyingQuestions?.[0]).toEqual({
      id: "q1",
      text: "What is the budget ceiling?",
      importance: "blocking",
    });
  });
});
