import { describe, expect, it } from "vitest";
import { SkipSource } from "../../src/decision-council/elicitation.js";

describe("SkipSource", () => {
  it("marks every question unanswered with its id", async () => {
    const source = new SkipSource();

    const answers = await source.resolve({
      runId: "run-1",
      roundNumber: 2,
      questions: [
        { id: "q1", text: "What is the budget ceiling?" },
        { id: "q2", text: "On-prem or cloud?", choices: ["on-prem", "cloud"] },
      ],
    });

    expect(answers).toEqual([
      { questionId: "q1", answeredBy: "unanswered" },
      { questionId: "q2", answeredBy: "unanswered" },
    ]);
  });

  it("returns an empty result when there are no questions", async () => {
    const source = new SkipSource();

    const answers = await source.resolve({ runId: "run-1", roundNumber: 1, questions: [] });

    expect(answers).toEqual([]);
  });
});
