import { describe, expect, it } from "vitest";
import type { CritiqueNormalizer, JudgeReducer } from "../../src/decision-council/bamlAdapters.js";

describe("BAML adapter seams", () => {
  it("allows tests to replace critique normalization", async () => {
    const normalizer: CritiqueNormalizer = {
      async normalizeCritique({ personaId }) {
        return {
          personaId,
          overallSummary: "Summary for compact progress output.",
          summary: "Summary",
          claims: ["Claim"],
          risks: ["Risk"],
          questions: ["Question"],
          recommendations: ["Recommendation"],
        };
      },
    };

    await expect(
      normalizer.normalizeCritique({
        personaId: "socratic",
        text: "raw",
        transcript: [],
        metadata: {},
      }),
    ).resolves.toMatchObject({ personaId: "socratic" });
  });

  it("allows tests to replace Judge reduction", async () => {
    const judge: JudgeReducer = {
      async assessRound() {
        return {
          roundNumber: 1,
          consensus: "Enough agreement to stop.",
          disagreements: [],
          confidence: 0.8,
          convergence: 0.9,
          shouldContinue: false,
          diminishingReturns: false,
        };
      },
      async createFinalReport() {
        return {
          recommendation: "Ship v0.",
          rationale: ["The loop is proven."],
          strongestObjections: [],
          unresolvedQuestions: [],
          confidence: 0.8,
          convergence: 0.9,
          nextExperiment: "Run on another design.",
          finalReportMarkdown: "# Design Council Report\n\nShip v0.",
          failedPersonas: [],
        };
      },
    };

    await expect(judge.assessRound({ roundNumber: 1, critiques: [], failures: [] })).resolves.toMatchObject({
      shouldContinue: false,
    });
  });
});
