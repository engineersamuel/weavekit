import { describe, expect, it } from "vitest";
import type { CritiqueNormalizer, JudgeReducer } from "../../src/decision-council/bamlAdapters.js";
import { GeneratedBamlAdapters, type RoutableBamlClient } from "../../src/decision-council/bamlAdapters.js";
import { PolicyModelRouter } from "../../src/decision-council/modelRouter.js";
import type { DecisionPersonaCritique, DecisionRoundAssessment, DecisionCouncilReport } from "../../src/decision-council/types.js";

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

  function fakeBamlClient(capture: { options: unknown[] }): RoutableBamlClient {
    const critique: DecisionPersonaCritique = {
      personaId: "skeptic",
      overallSummary: "ok",
      summary: "ok",
      claims: ["c"],
      risks: ["r"],
      questions: ["q"],
      recommendations: ["rec"],
    };
    const assessment: DecisionRoundAssessment = {
      roundNumber: 1,
      consensus: "stop",
      disagreements: [],
      confidence: 0.8,
      convergence: 0.9,
      shouldContinue: false,
      diminishingReturns: false,
    };
    const report: DecisionCouncilReport = {
      recommendation: "ship",
      rationale: ["r"],
      strongestObjections: [],
      unresolvedQuestions: [],
      confidence: 0.8,
      convergence: 0.9,
      nextExperiment: "try",
      finalReportMarkdown: "# Decision Council Report\n\nShip.",
      failedPersonas: [],
    };
    return {
      async NormalizePersonaCritique(_args, options) {
        capture.options.push(options);
        return critique;
      },
      async AssessCouncilRound(_round, _critiques, _failures, options) {
        capture.options.push(options);
        return assessment;
      },
      async CreateCouncilReport(_critiques, _assessments, _failures, options) {
        capture.options.push(options);
        return report;
      },
    };
  }

  describe("GeneratedBamlAdapters routing", () => {
    it("passes the policy client for normalize calls", async () => {
      const capture = { options: [] as unknown[] };
      const adapters = new GeneratedBamlAdapters({
        router: new PolicyModelRouter(),
        bamlClient: fakeBamlClient(capture),
        bamlEnv: {},
      });

      await adapters.normalizeCritique({ personaId: "skeptic", text: "raw", transcript: [], metadata: {} });
      expect(capture.options[0]).toEqual({ client: "CopilotProxyClaudeHaiku45" });
    });

    it("passes no override when no router is configured (back-compat)", async () => {
      const capture = { options: [] as unknown[] };
      const adapters = new GeneratedBamlAdapters({ bamlClient: fakeBamlClient(capture) });

      await adapters.assessRound({ roundNumber: 1, critiques: [], failures: [] });
      expect(capture.options[0]).toBeUndefined();
    });

    it("reports the routed model via the onModel callback", async () => {
      const capture = { options: [] as unknown[] };
      const adapters = new GeneratedBamlAdapters({
        router: new PolicyModelRouter(),
        bamlClient: fakeBamlClient(capture),
        bamlEnv: {},
      });

      let normalizeModel: string | undefined;
      await adapters.normalizeCritique(
        { personaId: "skeptic", text: "raw", transcript: [], metadata: {} },
        (model) => {
          normalizeModel = model;
        },
      );
      expect(normalizeModel).toBe("claude-haiku-4-5");

      let assessModel: string | undefined;
      await adapters.assessRound({ roundNumber: 1, critiques: [], failures: [] }, (model) => {
        assessModel = model;
      });
      expect(assessModel).toBe("claude-sonnet-4-6");
    });

    it("reports an undefined model via onModel when no router is configured", async () => {
      const capture = { options: [] as unknown[] };
      const adapters = new GeneratedBamlAdapters({ bamlClient: fakeBamlClient(capture) });

      let observed: string | undefined = "unset";
      await adapters.normalizeCritique(
        { personaId: "skeptic", text: "raw", transcript: [], metadata: {} },
        (model) => {
          observed = model;
        },
      );
      expect(observed).toBeUndefined();
    });

    it("trims critiques to per-persona summaries for the final report", async () => {
      const reportCritiques: unknown[] = [];
      const client: RoutableBamlClient = {
        async NormalizePersonaCritique() {
          throw new Error("not used in this test");
        },
        async AssessCouncilRound() {
          throw new Error("not used in this test");
        },
        async CreateCouncilReport(critiques) {
          reportCritiques.push(critiques);
          return {
            recommendation: "ship",
            rationale: ["r"],
            strongestObjections: [],
            unresolvedQuestions: [],
            confidence: 0.8,
            convergence: 0.9,
            nextExperiment: "try",
            finalReportMarkdown: "# Decision Council Report\n\nShip.",
            failedPersonas: [],
          };
        },
      };
      const adapters = new GeneratedBamlAdapters({ bamlClient: client, bamlEnv: {} });
      const fullCritique: DecisionPersonaCritique = {
        personaId: "skeptic",
        overallSummary: "Stance in one sentence.",
        summary: "A longer per-persona summary paragraph.",
        claims: ["claim"],
        risks: ["risk"],
        questions: ["question"],
        recommendations: ["recommendation"],
      };

      await adapters.createFinalReport({ critiques: [fullCritique], assessments: [], failures: [] });

      // The report receives only per-persona summaries, never the verbose claim/risk/
      // question/recommendation arrays, to keep the slow report generation within the
      // proxy timeout. Full critiques remain authoritative in the run state.
      expect(reportCritiques[0]).toEqual([
        {
          personaId: "skeptic",
          overallSummary: "Stance in one sentence.",
          summary: "A longer per-persona summary paragraph.",
        },
      ]);
    });
  });
});
