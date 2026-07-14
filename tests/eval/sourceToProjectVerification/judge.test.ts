import { describe, expect, it } from "vitest";
import * as judgeModule from "../../../src/eval/sourceToProjectVerification/judge.js";
import { resolvePairwisePanel } from "../../../src/eval/sourceToProjectVerification/judge.js";

describe("source-to-project judge projection helpers", () => {
  it("does not expose an executable judge coordinator outside Promptfoo", () => {
    expect(Object.hasOwn(judgeModule, "runProjectVerificationJudgePanel")).toBe(false);
  });

  it("reports disagreement, a single valid judge, and ties without forcing a winner", () => {
    expect(
      resolvePairwisePanel([pairwiseRecord("gpt", "weavekit"), pairwiseRecord("claude", "codex")]),
    ).toMatchObject({ status: "disputed" });
    expect(
      resolvePairwisePanel([
        pairwiseRecord("gpt", "tie"),
        {
          judgeId: "claude",
          planAProviderId: "weavekit",
          planBProviderId: "codex",
          elapsedMs: 1,
          error: "down",
        },
      ]),
    ).toMatchObject({ status: "single-judge", winner: "tie" });
    expect(
      resolvePairwisePanel([pairwiseRecord("gpt", "tie"), pairwiseRecord("claude", "tie")]),
    ).toMatchObject({ status: "agreed", winner: "tie" });
  });
});

function pairwiseRecord(judgeId: string, mappedWinner: string) {
  return {
    judgeId,
    planAProviderId: "weavekit",
    planBProviderId: "codex",
    elapsedMs: 1,
    mappedWinner,
    result: {
      winner: mappedWinner === "tie" ? ("tie" as const) : ("plan-a" as const),
      confidence: 0.9,
      decidingFactors: [],
      planAStrengths: [],
      planAGaps: [],
      planBStrengths: [],
      planBGaps: [],
      rationale: "comparison",
    },
  };
}
