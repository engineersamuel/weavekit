import { describe, expect, it } from "vitest";
import {
  resolvePairwisePanel,
  runProjectVerificationJudgePanel,
  type PairwiseJudgeInput,
  type SourceToProjectPlanJudge,
} from "../../../src/eval/sourceToProjectVerification/judge.js";
import type {
  SourceToProjectPairwiseJudgment,
  SourceToProjectPlanJudgment,
} from "../../../src/generated/baml_client/types.js";

const ABSOLUTE: SourceToProjectPlanJudgment = {
  requirementAssessments: [],
  criterionAssessments: [],
  contradictions: [],
  unsupportedRecommendations: [],
  summary: "ok",
};

describe("source-to-project judge panel", () => {
  it("rejects an empty judge panel", async () => {
    await expect(
      runProjectVerificationJudgePanel({
        caseId: "case-1",
        trialId: "trial-1",
        caseJson: "{}",
        plans: [{ providerId: "weavekit", markdown: "WEAVEKIT PLAN" }],
        judges: [],
      }),
    ).rejects.toThrow(/at least one judge/i);
  });

  it("counterbalances pairwise order and maps anonymous agreement to a provider", async () => {
    const calls: Array<{ judge: string; input: PairwiseJudgeInput }> = [];
    const judges = [fakeJudge("gpt", "plan-a", calls), fakeJudge("claude", "plan-b", calls)];

    const panel = await runProjectVerificationJudgePanel({
      caseId: "case-1",
      trialId: "trial-1",
      caseJson: '{"requirements":[{"id":"requirement-1"}]}',
      plans: [
        { providerId: "weavekit", markdown: "WEAVEKIT PLAN" },
        { providerId: "codex", markdown: "CODEX PLAN" },
      ],
      judges,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.input.planA).toBe(calls[1]?.input.planB);
    expect(calls[0]?.input.planB).toBe(calls[1]?.input.planA);
    expect(panel.pairwise[0]).toMatchObject({ status: "agreed" });
    expect(panel.pairwise[0]?.winner).toBe(panel.pairwise[0]?.judgments[0]?.mappedWinner);
    expect(panel.absolute[0]).toMatchObject({
      bamlClientName: "gpt-client",
      requirementIds: ["requirement-1"],
      elapsedMs: expect.any(Number),
      repairAttempted: false,
      retryCount: 0,
      evidenceDefectCount: 0,
      evidenceDefectCodes: [],
      evidenceDefectOmittedCount: 0,
    });
    expect(panel.pairwise[0]?.judgments[0]).toMatchObject({
      bamlClientName: "gpt-client",
      elapsedMs: expect.any(Number),
    });
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

  it("invalidates an out-of-range pairwise confidence", async () => {
    const judge: SourceToProjectPlanJudge = {
      id: "invalid-confidence",
      judgePlan: async () => ABSOLUTE,
      comparePlans: async () =>
        ({
          winner: "plan-a",
          confidence: 1.1,
          decidingFactors: [],
          planAStrengths: [],
          planAGaps: [],
          planBStrengths: [],
          planBGaps: [],
          rationale: "invalid confidence",
        }) as SourceToProjectPairwiseJudgment,
    };

    const panel = await runProjectVerificationJudgePanel({
      caseId: "case-1",
      trialId: "trial-1",
      caseJson: "{}",
      plans: [
        { providerId: "weavekit", markdown: "WEAVEKIT PLAN" },
        { providerId: "codex", markdown: "CODEX PLAN" },
      ],
      judges: [judge],
    });

    expect(panel.pairwise[0]).toMatchObject({ status: "invalid" });
    expect(panel.pairwise[0]?.judgments[0]?.error).toMatch(/confidence.*0.*1/i);
  });
});

function fakeJudge(
  id: string,
  winner: SourceToProjectPairwiseJudgment["winner"],
  calls: Array<{ judge: string; input: PairwiseJudgeInput }>,
): SourceToProjectPlanJudge {
  return {
    id,
    bamlClientName: `${id}-client`,
    judgePlan: async () => ABSOLUTE,
    comparePlans: async (input) => {
      calls.push({ judge: id, input });
      return {
        winner,
        confidence: 0.9,
        decidingFactors: [],
        planAStrengths: [],
        planAGaps: [],
        planBStrengths: [],
        planBGaps: [],
        rationale: "comparison",
      };
    },
  };
}

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
