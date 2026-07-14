import { describe, expect, it, vi } from "vitest";
import { createPromptfooJudgeProviders } from "../../../src/eval/sourceToProjectVerification/promptfooJudgeProvider.js";
import type {
  AbsoluteJudgeRepairMetadata,
  PairwiseJudgeInput,
  SourceToProjectPlanJudge,
} from "../../../src/eval/sourceToProjectVerification/judge.js";
import type {
  SourceToProjectPairwiseJudgment,
  SourceToProjectPlanJudgment,
} from "../../../src/generated/baml_client/types.js";

const ABSOLUTE_RESULT: SourceToProjectPlanJudgment = {
  requirementAssessments: [],
  criterionAssessments: [],
  contradictions: [],
  unsupportedRecommendations: [],
  summary: "sound plan",
};

const PAIRWISE_RESULT: SourceToProjectPairwiseJudgment = {
  winner: "plan-a",
  confidence: 0.9,
  decidingFactors: ["better evidence"],
  planAStrengths: ["specific"],
  planAGaps: [],
  planBStrengths: [],
  planBGaps: ["vague"],
  rationale: "Plan A is more specific.",
};

const REPAIR_METADATA: AbsoluteJudgeRepairMetadata = {
  repairAttempted: true,
  retryCount: 1,
  evidenceDefectCount: 2,
  evidenceDefectCodes: ["blank-quote", "quote-not-in-plan"],
  evidenceDefectOmittedCount: 0,
};

const SECRET_ERROR_MESSAGE = [
  "safe upstream context",
  "Authorization: Bearer bearer-secret-value",
  "api_key=lower-secret-value",
  "API_KEY=upper-secret-value",
  "key=generic-secret-value",
  "token=token-secret-value",
  "sk-project-secret-value",
  "x".repeat(4_000),
].join(" ");

describe("Promptfoo source-to-project judge providers", () => {
  it.each(["", "   "])("rejects a blank judge ID (%j)", (id) => {
    expect(() => createPromptfooJudgeProviders([fakeJudge({ id })])).toThrow(
      /judge id.*non-empty/i,
    );
  });

  it("rejects duplicate judge IDs before creating colliding providers", () => {
    expect(() =>
      createPromptfooJudgeProviders([
        fakeJudge({ id: "duplicate" }),
        fakeJudge({ id: "duplicate" }),
      ]),
    ).toThrow(/duplicate judge id.*duplicate/i);
  });

  it("dispatches an absolute task through the recorded outcome and preserves repair metadata", async () => {
    const judgePlan = vi.fn(async () => {
      throw new Error("metadata-aware path was bypassed");
    });
    const judgePlanWithMetadata = vi.fn(async () => ({
      ok: true as const,
      result: ABSOLUTE_RESULT,
      repairMetadata: REPAIR_METADATA,
    }));
    const [provider] = createPromptfooJudgeProviders([
      fakeJudge({ id: "gpt-5.5", judgePlan, judgePlanWithMetadata }),
    ]);

    const response = await provider!.callApi(
      JSON.stringify({
        kind: "absolute",
        caseJson: '{"id":"case-1"}',
        providerId: "weavekit",
        planMarkdown: "# Plan",
      }),
    );

    expect(provider!.id()).toBe("source-to-project-judge:gpt-5.5");
    expect(judgePlanWithMetadata).toHaveBeenCalledWith({
      caseJson: '{"id":"case-1"}',
      planMarkdown: "# Plan",
    });
    expect(judgePlan).not.toHaveBeenCalled();
    expect(JSON.parse(String(response.output))).toEqual(ABSOLUTE_RESULT);
    expect(response.metadata).toMatchObject({
      kind: "absolute",
      judgeId: "gpt-5.5",
      bamlClientName: "client-gpt-5.5",
      providerId: "weavekit",
      repairMetadata: REPAIR_METADATA,
    });
  });

  it("returns a Promptfoo error for a failed recorded absolute outcome", async () => {
    const [provider] = createPromptfooJudgeProviders([
      fakeJudge({
        id: "gpt-5.5",
        judgePlanWithMetadata: async () => ({
          ok: false,
          error: new Error("repair transport failed"),
          repairMetadata: REPAIR_METADATA,
        }),
      }),
    ]);

    const response = await provider!.callApi(
      JSON.stringify({
        kind: "absolute",
        caseJson: "{}",
        providerId: "codex",
        planMarkdown: "PLAN",
      }),
    );

    expect(response.output).toBeUndefined();
    expect(response.error).toContain("repair transport failed");
    expect(response.metadata).toMatchObject({
      judgeId: "gpt-5.5",
      providerId: "codex",
      repairMetadata: REPAIR_METADATA,
    });
  });

  it("redacts and bounds recorded absolute judge errors", async () => {
    const [provider] = createPromptfooJudgeProviders([
      fakeJudge({
        id: "gpt-5.5",
        judgePlanWithMetadata: async () => ({
          ok: false,
          error: new Error(SECRET_ERROR_MESSAGE),
          repairMetadata: REPAIR_METADATA,
        }),
      }),
    ]);

    const response = await provider!.callApi(
      JSON.stringify({
        kind: "absolute",
        caseJson: "{}",
        providerId: "codex",
        planMarkdown: "PLAN",
      }),
    );

    expectSafePersistedError(response.error);
  });

  it("rejects an absolute task when the judge lacks metadata-aware outcome support", async () => {
    const judgePlan = vi.fn(async () => ABSOLUTE_RESULT);
    const [provider] = createPromptfooJudgeProviders([
      fakeJudge({ id: "legacy-judge", judgePlan }),
    ]);

    const response = await provider!.callApi(
      JSON.stringify({
        kind: "absolute",
        caseJson: "{}",
        providerId: "codex",
        planMarkdown: "PLAN",
      }),
    );

    expect(judgePlan).not.toHaveBeenCalled();
    expect(response.output).toBeUndefined();
    expect(response.error).toMatch(/legacy-judge.*judgePlanWithMetadata/i);
    expect(response.metadata).toMatchObject({
      judgeId: "legacy-judge",
      providerId: "codex",
      repairMetadata: {
        repairAttempted: false,
        retryCount: 0,
      },
    });
  });

  it("counterbalances pairwise tasks across the default judge IDs and maps the anonymous winner", async () => {
    const calls: Array<{ judgeId: string; input: PairwiseJudgeInput }> = [];
    const judges = [
      fakeJudge({ id: "gpt-5.5", calls }),
      fakeJudge({ id: "claude-opus-4.8", calls }),
    ];
    const providers = createPromptfooJudgeProviders(judges);
    const task = JSON.stringify({
      kind: "pairwise",
      caseId: "case-1",
      trialId: "trial-1",
      caseJson: "{}",
      providerIds: ["codex", "weavekit"],
      plans: { codex: "CODEX PLAN", weavekit: "WEAVEKIT PLAN" },
    });

    const responses = await Promise.all(providers.map((provider) => provider.callApi(task)));

    expect(calls).toHaveLength(2);
    expect(calls[0]!.input.planA).toBe(calls[1]!.input.planB);
    expect(calls[0]!.input.planB).toBe(calls[1]!.input.planA);
    for (const [index, response] of responses.entries()) {
      expect(JSON.parse(String(response.output))).toEqual(PAIRWISE_RESULT);
      const call = calls[index]!;
      const expectedPlanAProviderId = call.input.planA === "CODEX PLAN" ? "codex" : "weavekit";
      const expectedPlanBProviderId = expectedPlanAProviderId === "codex" ? "weavekit" : "codex";
      expect(response.metadata).toMatchObject({
        kind: "pairwise",
        judgeId: judges[index]!.id,
        bamlClientName: `client-${judges[index]!.id}`,
        providerIds: ["codex", "weavekit"],
        planAProviderId: expectedPlanAProviderId,
        planBProviderId: expectedPlanBProviderId,
        anonymousOrder: {
          planAProviderId: expectedPlanAProviderId,
          planBProviderId: expectedPlanBProviderId,
        },
        anonymousWinner: "plan-a",
        mappedWinner: expectedPlanAProviderId,
      });
    }
  });

  it.each([
    ["malformed JSON", "not-json"],
    ["unknown task", JSON.stringify({ kind: "ranking" })],
    [
      "mismatched provider plans",
      JSON.stringify({
        kind: "pairwise",
        caseId: "case",
        trialId: "trial",
        caseJson: "{}",
        providerIds: ["codex", "weavekit"],
        plans: { codex: "CODEX", extra: "EXTRA" },
      }),
    ],
    [
      "duplicate providers",
      JSON.stringify({
        kind: "pairwise",
        caseId: "case",
        trialId: "trial",
        caseJson: "{}",
        providerIds: ["codex", "codex"],
        plans: { codex: "CODEX" },
      }),
    ],
  ])("returns a Promptfoo error for %s", async (_label, prompt) => {
    const [provider] = createPromptfooJudgeProviders([fakeJudge({ id: "gpt-5.5" })]);

    await expect(provider!.callApi(prompt)).resolves.toMatchObject({
      error: expect.stringMatching(/invalid promptfoo judge task/i),
      metadata: {
        judgeId: "gpt-5.5",
        bamlClientName: "client-gpt-5.5",
      },
    });
  });

  it("converts a thrown pairwise transport error into a Promptfoo error", async () => {
    const [provider] = createPromptfooJudgeProviders([
      fakeJudge({
        id: "gpt-5.5",
        comparePlans: async () => {
          throw new Error(`pairwise transport failed: ${SECRET_ERROR_MESSAGE}`);
        },
      }),
    ]);

    const response = await provider!.callApi(
      JSON.stringify({
        kind: "pairwise",
        caseId: "case",
        trialId: "trial",
        caseJson: "{}",
        providerIds: ["codex", "weavekit"],
        plans: { codex: "CODEX", weavekit: "WEAVEKIT" },
      }),
    );

    expect(response.output).toBeUndefined();
    expect(response.error).toContain("pairwise transport failed");
    expectSafePersistedError(response.error);
    expect(response.metadata).toMatchObject({ judgeId: "gpt-5.5", kind: "pairwise" });
  });

  it("redacts and bounds schema validation errors", async () => {
    const [provider] = createPromptfooJudgeProviders([fakeJudge({ id: "gpt-5.5" })]);

    const response = await provider!.callApi(
      JSON.stringify({
        kind: "absolute",
        caseJson: "{}",
        providerId: "codex",
        planMarkdown: "PLAN",
        [SECRET_ERROR_MESSAGE]: true,
      }),
    );

    expect(response.error).toMatch(/invalid promptfoo judge task/i);
    expectSafePersistedError(response.error);
  });
});

function fakeJudge(options: {
  id: string;
  calls?: Array<{ judgeId: string; input: PairwiseJudgeInput }>;
  judgePlan?: SourceToProjectPlanJudge["judgePlan"];
  judgePlanWithMetadata?: SourceToProjectPlanJudge["judgePlanWithMetadata"];
  comparePlans?: SourceToProjectPlanJudge["comparePlans"];
}): SourceToProjectPlanJudge {
  return {
    id: options.id,
    bamlClientName: `client-${options.id}`,
    judgePlan: options.judgePlan ?? (async () => ABSOLUTE_RESULT),
    ...(options.judgePlanWithMetadata
      ? { judgePlanWithMetadata: options.judgePlanWithMetadata }
      : {}),
    comparePlans:
      options.comparePlans ??
      (async (input) => {
        options.calls?.push({ judgeId: options.id, input });
        return PAIRWISE_RESULT;
      }),
  };
}

function expectSafePersistedError(error: unknown): void {
  expect(error).toBeTypeOf("string");
  const message = String(error);
  expect(message.length).toBeLessThanOrEqual(1_024);
  expect(message).toContain("safe upstream context");
  expect(message).toContain("[REDACTED]");
  expect(message).not.toMatch(
    /bearer-secret-value|lower-secret-value|upper-secret-value|generic-secret-value|token-secret-value|sk-project-secret-value/,
  );
  expect(message).not.toContain("Error:");
  expect(message).not.toContain("\n    at ");
}
