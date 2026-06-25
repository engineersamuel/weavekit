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
      overallSummary: `${raw.personaId} recommends testing the riskiest assumption first.`,
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
        finalReportMarkdown: "# Design Council Report\n\nUse Flue for v0.",
        failedPersonas: failures,
      };
    },
  };
}

describe("runCouncil", () => {
  it("emits progress events for the council run", async () => {
    const events: string[] = [];

    await runCouncil(
      { prompt: "Log this run." },
      {
        deps: {
          personaWorker: fakeWorker(),
          normalizer,
          judge: judge(1),
          writeArtifacts: false,
        },
        logger: {
          event(event) {
            events.push(event.type);
          },
        },
      },
    );

    expect(events).toContain("council.run.started");
    expect(events).toContain("council.round.started");
    expect(events).toContain("council.persona.started");
    expect(events).toContain("council.persona.completed");
    expect(events).toContain("council.baml.started");
    expect(events).toContain("council.baml.completed");
    expect(events).toContain("council.round.completed");
    expect(events).toContain("council.run.completed");
  });

  it("emits normalized summary and shared round source metadata", async () => {
    const events: unknown[] = [];

    await runCouncil(
      { prompt: "Log summaries across rounds." },
      {
        deps: {
          personaWorker: fakeWorker(),
          normalizer,
          judge: judge(2),
          writeArtifacts: false,
        },
        logger: {
          event(event) {
            events.push(event);
          },
        },
      },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "council.round.started",
        roundNumber: 1,
        focusSource: "initial",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "council.round.started",
        roundNumber: 2,
        focusSource: "judge",
        previousRoundNumber: 1,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "council.baml.completed",
        operation: "normalize",
        personaId: "pragmatic",
        summary: "pragmatic recommends testing the riskiest assumption first.",
      }),
    );
  });

  it("overwrites hallucinated failedPersonas from judge with authoritative run-state failures", async () => {
    // The LLM can fabricate or drop failed personas; deterministic run-state must win.
    const hallucinatingJudge: JudgeReducer = {
      assessRound: judge(1).assessRound,
      async createFinalReport() {
        return {
          recommendation: "Use Flue.",
          rationale: ["OK"],
          strongestObjections: [],
          unresolvedQuestions: [],
          confidence: 0.8,
          convergence: 0.9,
          nextExperiment: "Try it.",
          finalReportMarkdown: "# Design Council Report\n\nUse Flue.",
          failedPersonas: [{ personaId: "hallucinated", message: "invented by LLM", retryable: false }],
        };
      },
    };

    const report = await runCouncil(
      { prompt: "Test hallucination." },
      {
        deps: {
          personaWorker: fakeWorker(["socratic"]),
          normalizer,
          judge: hallucinatingJudge,
          writeArtifacts: false,
        },
      },
    );

    const failedIds = report.failedPersonas.map((f) => f.personaId);
    expect(failedIds).not.toContain("hallucinated");
    expect(failedIds).toContain("socratic");
  });

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
