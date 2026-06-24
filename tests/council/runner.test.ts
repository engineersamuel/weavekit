import { describe, expect, it } from "vitest";
import { runCouncil } from "../../src/council/runner.js";
import { createCouncilWorkflow } from "../../src/council/workflow.js";
import { defaultPersonaSet } from "../../src/council/personas.js";
import type { JudgeReducer, CritiqueNormalizer } from "../../src/council/bamlAdapters.js";
import type { PersonaWorker } from "../../src/council/personaWorker.js";

function fakeWorker(failPersonaIds: string[] = []): PersonaWorker {
  return {
    async runPersona({ persona, brief }) {
      if (failPersonaIds.includes(persona.id)) {
        throw new Error(`${persona.id} failed`);
      }

      return {
        personaId: persona.id,
        text: `${persona.name} critique for round ${brief.roundNumber}`,
        transcript: [`assistant: ${persona.name}`],
        metadata: { model: "fake" },
      };
    },
  };
}

const normalizer: CritiqueNormalizer = {
  async normalizeCritique(raw) {
    return {
      personaId: raw.personaId,
      summary: raw.text,
      claims: [`${raw.personaId} claim`],
      risks: [`${raw.personaId} risk`],
      questions: [`${raw.personaId} question`],
      recommendations: [`${raw.personaId} recommendation`],
    };
  },
};

function judge(roundsBeforeStop: number): JudgeReducer {
  return {
    async assessRound({ roundNumber }) {
      return {
        roundNumber,
        consensus: roundNumber >= roundsBeforeStop ? "Stop" : "Continue",
        disagreements: [],
        confidence: roundNumber >= roundsBeforeStop ? 0.8 : 0.4,
        convergence: roundNumber >= roundsBeforeStop ? 0.9 : 0.3,
        shouldContinue: roundNumber < roundsBeforeStop,
        diminishingReturns: false,
        nextRoundBrief: "Focus on remaining objections.",
      };
    },
    async createFinalReport({ failures }) {
      return {
        recommendation: "Use Flue for v0.",
        rationale: ["The workflow loop completed."],
        strongestObjections: ["Framework churn."],
        unresolvedQuestions: [],
        confidence: 0.8,
        convergence: 0.9,
        nextExperiment: "Run the council on a real design.",
        failedPersonas: failures,
      };
    },
  };
}

describe("runCouncil", () => {
  it("runs personas, normalizes critiques, and returns a final report", async () => {
    const report = await runCouncil(
      { prompt: "Should Weavekit use Flue?" },
      {
        personaSet: defaultPersonaSet,
        deps: {
          personaWorker: fakeWorker(),
          normalizer,
          judge: judge(1),
          writeArtifacts: false,
        },
      },
    );

    expect(report.recommendation).toBe("Use Flue for v0.");
    expect(report.failedPersonas).toEqual([]);
  });

  it("stops at max three rounds even if Judge asks to continue", async () => {
    let assessmentCount = 0;
    const trackingJudge: JudgeReducer = {
      async assessRound({ roundNumber, critiques, failures }) {
        assessmentCount++;
        return judge(10).assessRound({ roundNumber, critiques, failures });
      },
      createFinalReport: judge(10).createFinalReport,
    };

    const report = await runCouncil(
      { prompt: "Keep debating forever." },
      {
        deps: {
          personaWorker: fakeWorker(),
          normalizer,
          judge: trackingJudge,
          writeArtifacts: false,
        },
      },
    );

    expect(report.recommendation).toBe("Use Flue for v0.");
    expect(assessmentCount).toBe(3);
  });

  it("fails when fewer than two debating personas succeed", async () => {
    await expect(
      runCouncil(
        { prompt: "Handle failures." },
        {
          deps: {
            personaWorker: fakeWorker(["socratic", "deep-module-dry", "pragmatic"]),
            normalizer,
            judge: judge(1),
            writeArtifacts: false,
          },
        },
      ),
    ).rejects.toThrow("Council requires at least two successful personas.");
  });
});

describe("createCouncilWorkflow", () => {
  it("returns a workflow object without throwing when called with valid deps", () => {
    expect(() =>
      createCouncilWorkflow({
        personaWorker: fakeWorker(),
        normalizer,
        judge: judge(1),
      }),
    ).not.toThrow();
  });
});
