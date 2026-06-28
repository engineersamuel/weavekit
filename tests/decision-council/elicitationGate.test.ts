import { describe, expect, it } from "vitest";
import { SkipSource, type ElicitationSource } from "../../src/decision-council/elicitation.js";
import { applyElicitation } from "../../src/decision-council/elicitationGate.js";
import type { DecisionCouncilRunState, DecisionRoundAssessment } from "../../src/decision-council/types.js";

function baseState(): DecisionCouncilRunState {
  return {
    input: { prompt: "Decide X", context: ["existing"], constraints: [] },
    personas: [],
    maxRounds: 3,
    rounds: [],
  };
}

function assessment(overrides: Partial<DecisionRoundAssessment> = {}): DecisionRoundAssessment {
  return {
    roundNumber: 1,
    consensus: "lean yes",
    disagreements: [],
    confidence: 0.5,
    convergence: 0.5,
    shouldContinue: true,
    diminishingReturns: false,
    needsHumanInput: false,
    clarifyingQuestions: [],
    ...overrides,
  };
}

const answeringSource: ElicitationSource = {
  async resolve(request) {
    return request.questions.map((question) => ({
      questionId: question.id,
      answeredBy: "human" as const,
      answer: `ans-${question.id}`,
    }));
  },
};

describe("applyElicitation", () => {
  it("returns the state untouched when the assessment does not request human input", async () => {
    const state = baseState();

    const result = await applyElicitation(state, assessment(), new SkipSource(), {
      runId: "run-1",
      roundNumber: 1,
    });

    expect(result.state).toBe(state);
    expect(result.answers).toEqual([]);
  });

  it("leaves the input context unchanged when the source answers nothing (SkipSource)", async () => {
    const state = baseState();

    const result = await applyElicitation(
      state,
      assessment({ needsHumanInput: true, clarifyingQuestions: [{ id: "q1", text: "Budget?" }] }),
      new SkipSource(),
      { runId: "run-1", roundNumber: 1 },
    );

    expect(result.state).toBe(state);
    expect(result.state.input.context).toEqual(["existing"]);
    expect(result.answers).toEqual([{ questionId: "q1", answeredBy: "unanswered" }]);
  });

  it("folds answered clarifications into the run input context without mutating the original", async () => {
    const state = baseState();

    const result = await applyElicitation(
      state,
      assessment({ needsHumanInput: true, clarifyingQuestions: [{ id: "q1", text: "Budget?" }] }),
      answeringSource,
      { runId: "run-1", roundNumber: 2 },
    );

    expect(result.state.input.context).toEqual(["existing", "Clarification (q1): ans-q1"]);
    expect(state.input.context).toEqual(["existing"]);
    expect(result.answers).toEqual([{ questionId: "q1", answeredBy: "human", answer: "ans-q1" }]);
  });

  it("treats an assessment without elicitation fields as a no-op", async () => {
    const state = baseState();
    const bare: DecisionRoundAssessment = {
      roundNumber: 1,
      consensus: "ok",
      disagreements: [],
      confidence: 0.5,
      convergence: 0.5,
      shouldContinue: true,
      diminishingReturns: false,
    };

    const result = await applyElicitation(state, bare, answeringSource, {
      runId: "run-1",
      roundNumber: 1,
    });

    expect(result.state).toBe(state);
    expect(result.answers).toEqual([]);
  });
});
