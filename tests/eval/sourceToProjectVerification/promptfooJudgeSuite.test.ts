import { createHash } from "node:crypto";
import {
  assertions,
  type ApiProvider,
  type AssertionValueFunction,
  type AssertionValueFunctionContext,
  type AtomicTestCase,
  type GradingResult,
  type ProviderResponse,
  type TestCase,
} from "promptfoo";
import { describe, expect, it } from "vitest";
import type {
  ProjectVerificationManifest,
  VerifiedPlanArtifact,
} from "../../../src/eval/sourceToProjectVerification/manifest.js";
import { shouldSwapPairwiseOrder } from "../../../src/eval/sourceToProjectVerification/judge.js";
import { buildPromptfooJudgeSuite } from "../../../src/eval/sourceToProjectVerification/promptfooJudgeSuite.js";

const CASE_JSON = JSON.stringify({
  id: "case-1",
  requirements: [{ id: "requirement-1" }, { id: "requirement-2" }],
  criteria: [{ criterion: "implementation-completeness" }],
});

const PLANS: VerifiedPlanArtifact[] = [
  { providerId: "weavekit", markdown: "# Third plan\nThird exact evidence." },
  { providerId: "codex", markdown: "# First plan\nFirst exact evidence." },
  { providerId: "copilot", markdown: "# Second plan\nSecond exact evidence." },
];

const MANIFEST = {
  version: 2,
  caseId: "case-1",
  caseSha256: "c".repeat(64),
  createdAt: "2026-07-12T12:00:00.000Z",
  promptfooGenerationEvaluationId: "generation-1",
  artifacts: PLANS.map((plan) => ({
    providerId: plan.providerId,
    generationSucceeded: true,
    workspaceMutationVerified: true,
    planPath: `/tmp/${plan.providerId}.md`,
    sha256: sha256(plan.markdown),
    errors: [],
  })),
} satisfies ProjectVerificationManifest;

const JUDGE_PROVIDERS: ApiProvider[] = [
  fakeProvider("source-to-project-judge:gpt-5.5"),
  fakeProvider("source-to-project-judge:claude-opus-4.8"),
];

describe("Promptfoo source-to-project judge suite", () => {
  it("builds three sorted absolute tasks followed by three sorted anonymous pairwise tasks", () => {
    const { suite, tasks } = buildPromptfooJudgeSuite({
      manifest: MANIFEST,
      plans: PLANS,
      caseJson: CASE_JSON,
      caseId: "case-1",
      trialId: "trial-1",
      judgeProviders: JUDGE_PROVIDERS,
    });

    expect(tasks.map((task) => task.kind)).toEqual([
      "absolute",
      "absolute",
      "absolute",
      "pairwise",
      "pairwise",
      "pairwise",
    ]);
    expect(
      tasks.map((task) =>
        task.kind === "absolute" ? task.providerId : task.providerIds.join("+"),
      ),
    ).toEqual([
      "codex",
      "copilot",
      "weavekit",
      "codex+copilot",
      "codex+weavekit",
      "copilot+weavekit",
    ]);
    expect(suite.providers).toEqual(JUDGE_PROVIDERS);
    expect(suite.prompts).toEqual(["{{task}}"]);
    const tests = suite.tests as TestCase[];
    expect(tests).toHaveLength(6);

    for (const [index, test] of tests.entries()) {
      expect(test.assert).toHaveLength(1);
      expect(test.assert![0]).toMatchObject({ type: "javascript" });
      expect(javascriptAssertion(test)).toBeTypeOf("function");
      expect(test.vars?.task).toBe(JSON.stringify(tasks[index]));
      expect(test.metadata).toMatchObject({
        taskKind: tasks[index]!.kind,
        judgeProviderIds: JUDGE_PROVIDERS.map((provider) => provider.id()),
        caseId: "case-1",
        trialId: "trial-1",
      });
      expect(test.metadata?.artifactHashes).toBeTruthy();
      expect(test.metadata?.taskProviderIds).toEqual(
        tasks[index]!.kind === "absolute" ? [tasks[index]!.providerId] : tasks[index]!.providerIds,
      );
    }

    const pairwiseTasks = tasks.filter((task) => task.kind === "pairwise");
    expect(pairwiseTasks[0]!.plans).toEqual({
      codex: "# First plan\nFirst exact evidence.",
      copilot: "# Second plan\nSecond exact evidence.",
    });
    expect(Object.values(pairwiseTasks[0]!.plans).join("\n")).not.toMatch(
      /codex|copilot|provider/i,
    );
  });

  it("builds two absolute tasks and their one pair when another provider failed generation", () => {
    const plans = PLANS.filter((plan) => plan.providerId !== "weavekit");
    const manifest = {
      ...MANIFEST,
      artifacts: MANIFEST.artifacts.map((artifact) =>
        artifact.providerId === "weavekit"
          ? {
              providerId: artifact.providerId,
              generationSucceeded: false,
              workspaceMutationVerified: true,
              errors: ["generation failed"],
            }
          : artifact,
      ),
    } satisfies ProjectVerificationManifest;

    const { tasks } = buildPromptfooJudgeSuite({
      manifest,
      plans,
      caseJson: CASE_JSON,
      caseId: "case-1",
      trialId: "trial-1",
      judgeProviders: JUDGE_PROVIDERS,
    });

    expect(tasks.map((task) => task.kind)).toEqual(["absolute", "absolute", "pairwise"]);
    expect(
      tasks.map((task) => (task.kind === "absolute" ? task.providerId : task.providerIds)),
    ).toEqual(["codex", "copilot", ["codex", "copilot"]]);
  });

  it("builds one absolute task and no pairwise tasks for one valid plan", () => {
    const plans = PLANS.filter((plan) => plan.providerId === "codex");
    const manifest = {
      ...MANIFEST,
      artifacts: MANIFEST.artifacts.map((artifact) =>
        artifact.providerId === "codex"
          ? artifact
          : {
              providerId: artifact.providerId,
              generationSucceeded: false,
              workspaceMutationVerified: true,
              errors: ["generation failed"],
            },
      ),
    } satisfies ProjectVerificationManifest;

    const { tasks } = buildPromptfooJudgeSuite({
      manifest,
      plans,
      caseJson: CASE_JSON,
      caseId: "case-1",
      trialId: "trial-1",
      judgeProviders: JUDGE_PROVIDERS,
    });

    expect(tasks).toEqual([expect.objectContaining({ kind: "absolute", providerId: "codex" })]);
  });

  it("accepts complete absolute evidence and returns a full Promptfoo grading result", async () => {
    const { test, assertion } = absoluteAssertion();

    const result = await invokeAssertion(assertion, test, JSON.stringify(absoluteResult()));

    expect(result).toEqual({
      pass: true,
      score: 1,
      reason: expect.any(String),
    });
  });

  it("executes the generated JavaScript assertion through Promptfoo's public runner", async () => {
    const { test } = absoluteAssertion();
    const assertion = test.assert![0]!;
    if (assertion.type === "assert-set") throw new Error("Expected a JavaScript assertion.");
    const output = JSON.stringify(absoluteResult());

    const result = await assertions.runAssertion({
      prompt: String(test.vars!.task),
      provider: JUDGE_PROVIDERS[0],
      assertion,
      test: test as AtomicTestCase,
      vars: test.vars!,
      providerResponse: { ...responseFor(test, output), output },
    });

    expect(result).toMatchObject({ pass: true, score: 1, reason: expect.any(String) });
  });

  it.each(["plan-a", "plan-b", "tie"] as const)(
    "accepts bounded pairwise output regardless of the %s winner choice",
    async (winner) => {
      const { test, assertion } = pairwiseAssertion();

      const result = await invokeAssertion(
        assertion,
        test,
        JSON.stringify(pairwiseResult({ winner })),
      );

      expect(result).toMatchObject({ pass: true, score: 1, reason: expect.any(String) });
    },
  );

  it.each([
    [
      "missing requirement IDs",
      () => JSON.stringify({ ...absoluteResult(), requirementAssessments: [requirementOne()] }),
      /missing requirement requirement-2/i,
      "absolute",
    ],
    [
      "duplicate requirement IDs",
      () =>
        JSON.stringify({
          ...absoluteResult(),
          requirementAssessments: [requirementOne(), requirementOne()],
        }),
      /duplicate requirement requirement-1/i,
      "absolute",
    ],
    [
      "out-of-range criterion score",
      () =>
        JSON.stringify({
          ...absoluteResult(),
          criterionAssessments: [{ ...criterion(), score: 5 }],
        }),
      /score must be an integer from 0 to 4/i,
      "absolute",
    ],
    [
      "out-of-range pairwise confidence",
      () => JSON.stringify(pairwiseResult({ confidence: 1.01 })),
      /confidence must be between 0 and 1/i,
      "pairwise",
    ],
    [
      "nonliteral evidence quote",
      () =>
        JSON.stringify({
          ...absoluteResult(),
          requirementAssessments: [
            { ...requirementOne(), evidenceQuotes: ["Invented plan evidence"] },
            requirementTwo(),
          ],
        }),
      /evidence quote is not in the plan/i,
      "absolute",
    ],
    ["malformed JSON", () => "{not-json", /valid json/i, "absolute"],
  ])("rejects %s with a bounded reason", async (_label, output, reason, taskKind) => {
    const selected = taskKind === "absolute" ? absoluteAssertion() : pairwiseAssertion();

    const result = await invokeAssertion(selected.assertion, selected.test, output());

    expect(result).toMatchObject({ pass: false, score: 0, reason });
    expect(result.reason.length).toBeLessThanOrEqual(1_024);
  });

  it("rejects an unsupported task kind from the rendered Promptfoo prompt", async () => {
    const { test, assertion } = absoluteAssertion();

    const result = await invokeAssertion(assertion, test, JSON.stringify(absoluteResult()), {
      prompt: JSON.stringify({ kind: "ranking" }),
    });

    expect(result).toMatchObject({
      pass: false,
      score: 0,
      reason: expect.stringMatching(/unsupported task kind.*ranking/i),
    });
  });

  it("rejects provider response metadata that does not match its absolute task", async () => {
    const { test, assertion } = absoluteAssertion();

    const result = await invokeAssertion(assertion, test, JSON.stringify(absoluteResult()), {
      providerResponse: {
        output: "",
        metadata: { kind: "absolute", judgeId: "gpt-5.5", providerId: "weavekit" },
      },
    });

    expect(result).toMatchObject({
      pass: false,
      score: 0,
      reason: expect.stringMatching(/response provider.*weavekit.*task provider.*codex/i),
    });
  });

  it.each([
    ["absolute case JSON", 0, (task: Record<string, unknown>) => (task.caseJson = "{}")],
    [
      "absolute plan markdown",
      0,
      (task: Record<string, unknown>) => (task.planMarkdown = "# Mutated plan"),
    ],
    ["pairwise case ID", 3, (task: Record<string, unknown>) => (task.caseId = "other-case")],
    ["pairwise trial ID", 3, (task: Record<string, unknown>) => (task.trialId = "other-trial")],
    ["pairwise case JSON", 3, (task: Record<string, unknown>) => (task.caseJson = "{}")],
    [
      "pairwise provider IDs",
      3,
      (task: Record<string, unknown>) =>
        (task.providerIds = [...(task.providerIds as string[])].reverse()),
    ],
    [
      "pairwise plans",
      3,
      (task: Record<string, unknown>) => {
        task.plans = { ...(task.plans as Record<string, string>), codex: "# Mutated plan" };
      },
    ],
  ])("rejects a rendered task with mutated %s", async (_label, index, mutate) => {
    const selected = assertionAt(index);
    const renderedTask = JSON.parse(String(selected.test.vars!.task)) as Record<string, unknown>;
    mutate(renderedTask);
    const output = index === 0 ? absoluteResult() : pairwiseResult();

    const result = await invokeAssertion(
      selected.assertion,
      selected.test,
      JSON.stringify(output),
      {
        prompt: JSON.stringify(renderedTask),
      },
    );

    expect(result).toMatchObject({
      pass: false,
      score: 0,
      reason: expect.stringMatching(/rendered.*task.*does not match.*expected/i),
    });
  });

  it.each([
    [
      "anonymous order",
      (metadata: Record<string, unknown>) =>
        (metadata.anonymousOrder = {
          planAProviderId: metadata.planBProviderId,
          planBProviderId: metadata.planAProviderId,
        }),
      /anonymous order/i,
    ],
    [
      "anonymous winner",
      (metadata: Record<string, unknown>) => (metadata.anonymousWinner = "plan-b"),
      /anonymous winner/i,
    ],
    [
      "mapped winner",
      (metadata: Record<string, unknown>) => (metadata.mappedWinner = "tie"),
      /mapped winner/i,
    ],
    [
      "missing plan A mapping",
      (metadata: Record<string, unknown>) => delete metadata.planAProviderId,
      /plan a provider/i,
    ],
  ])("rejects pairwise %s metadata mismatch", async (_label, mutate, reason) => {
    const { test, assertion } = pairwiseAssertion();
    const providerResponse = responseFor(test);
    mutate(providerResponse.metadata!);

    const result = await invokeAssertion(assertion, test, JSON.stringify(pairwiseResult()), {
      providerResponse,
    });

    expect(result).toMatchObject({ pass: false, score: 0, reason });
  });

  it("redacts and bounds secret-bearing assertion failures", async () => {
    const { test, assertion } = absoluteAssertion();
    const secret = "bearer-secret-value";

    const result = await invokeAssertion(assertion, test, JSON.stringify(absoluteResult()), {
      prompt: JSON.stringify({
        kind: `Authorization: Bearer ${secret} ${"x".repeat(4_000)}`,
      }),
    });

    expect(result).toMatchObject({ pass: false, score: 0 });
    expect(result.reason).toContain("[REDACTED]");
    expect(result.reason).not.toContain(secret);
    expect(result.reason.length).toBeLessThanOrEqual(1_024);
  });

  it.each([
    ["no valid plans", [], MANIFEST, JUDGE_PROVIDERS, /at least one/i],
    [
      "missing a valid manifest plan",
      PLANS.slice(0, 2),
      MANIFEST,
      JUDGE_PROVIDERS,
      /manifest provider.*copilot.*no verified plan/i,
    ],
    [
      "duplicate plans",
      [PLANS[0]!, PLANS[0]!, PLANS[1]!],
      MANIFEST,
      JUDGE_PROVIDERS,
      /duplicate plan provider.*weavekit/i,
    ],
    [
      "mismatched plan IDs",
      [...PLANS.slice(0, 2), { providerId: "other", markdown: "Other plan" }],
      MANIFEST,
      JUDGE_PROVIDERS,
      /plan provider.*other.*manifest/i,
    ],
    [
      "missing hashes",
      PLANS,
      {
        ...MANIFEST,
        artifacts: MANIFEST.artifacts.map((artifact, index) =>
          index === 0 ? { ...artifact, sha256: undefined } : artifact,
        ),
      },
      JUDGE_PROVIDERS,
      /missing.*hash.*weavekit/i,
    ],
    ["fewer than two judges", PLANS, MANIFEST, JUDGE_PROVIDERS.slice(0, 1), /exactly two.*judge/i],
    [
      "duplicate judge providers",
      PLANS,
      MANIFEST,
      [JUDGE_PROVIDERS[0]!, JUDGE_PROVIDERS[0]!],
      /duplicate judge provider/i,
    ],
  ])("fails closed for %s", (_label, plans, manifest, judgeProviders, reason) => {
    expect(() =>
      buildPromptfooJudgeSuite({
        manifest: manifest as ProjectVerificationManifest,
        plans,
        caseJson: CASE_JSON,
        caseId: "case-1",
        trialId: "trial-1",
        judgeProviders,
      }),
    ).toThrow(reason);
  });

  it("rejects substituted plan markdown that no longer matches its frozen hash", () => {
    const substitutedPlans = PLANS.map((plan) =>
      plan.providerId === "codex"
        ? { ...plan, markdown: "# Substituted plan\nUnfrozen content." }
        : plan,
    );

    expect(() =>
      buildPromptfooJudgeSuite({
        manifest: MANIFEST,
        plans: substitutedPlans,
        caseJson: CASE_JSON,
        caseId: "case-1",
        trialId: "trial-1",
        judgeProviders: JUDGE_PROVIDERS,
      }),
    ).toThrow(/plan hash mismatch.*codex/i);
  });
});

function absoluteAssertion(): { test: TestCase; assertion: AssertionValueFunction } {
  return assertionAt(0);
}

function pairwiseAssertion(): { test: TestCase; assertion: AssertionValueFunction } {
  return assertionAt(3);
}

function assertionAt(index: number): { test: TestCase; assertion: AssertionValueFunction } {
  const { suite } = buildPromptfooJudgeSuite({
    manifest: MANIFEST,
    plans: PLANS,
    caseJson: CASE_JSON,
    caseId: "case-1",
    trialId: "trial-1",
    judgeProviders: JUDGE_PROVIDERS,
  });
  const test = (suite.tests as TestCase[])[index]!;
  return { test, assertion: javascriptAssertion(test) };
}

function javascriptAssertion(test: TestCase): AssertionValueFunction {
  const assertion = test.assert![0]!;
  if (assertion.type === "assert-set") throw new Error("Expected a JavaScript assertion.");
  return assertion.value as AssertionValueFunction;
}

async function invokeAssertion(
  assertion: AssertionValueFunction,
  test: TestCase,
  output: string,
  overrides: { prompt?: string; providerResponse?: ProviderResponse } = {},
): Promise<GradingResult> {
  const providerResponse = overrides.providerResponse ?? responseFor(test, output);
  const result = await assertion(output, {
    prompt: overrides.prompt ?? String(test.vars!.task),
    vars: test.vars!,
    test,
    logProbs: undefined,
    provider: JUDGE_PROVIDERS[0],
    providerResponse,
    metadata: providerResponse.metadata,
  } as AssertionValueFunctionContext);
  return result as GradingResult;
}

function responseFor(test: TestCase, output?: string): ProviderResponse {
  const task = JSON.parse(String(test.vars!.task)) as {
    kind: "absolute" | "pairwise";
    providerId?: string;
    providerIds?: string[];
  };
  const metadata: Record<string, unknown> = {
    kind: task.kind,
    judgeId: "gpt-5.5",
    ...(task.providerId ? { providerId: task.providerId } : {}),
    ...(task.providerIds ? pairwiseMetadata(task.providerIds, readWinner(output)) : {}),
  };
  return {
    output: "",
    metadata,
  };
}

function pairwiseMetadata(
  providerIds: string[],
  winner: "plan-a" | "plan-b" | "tie" = "plan-a",
): Record<string, unknown> {
  const [leftProviderId, rightProviderId] = providerIds as [string, string];
  const judgeIds = ["gpt-5.5", "claude-opus-4.8"];
  const swap = shouldSwapPairwiseOrder({
    caseId: "case-1",
    trialId: "trial-1",
    leftProviderId,
    rightProviderId,
    judgeId: judgeIds[0]!,
    judgeIds,
  });
  const [planAProviderId, planBProviderId] = swap
    ? [rightProviderId, leftProviderId]
    : [leftProviderId, rightProviderId];
  return {
    providerIds,
    planAProviderId,
    planBProviderId,
    anonymousOrder: { planAProviderId, planBProviderId },
    anonymousWinner: winner,
    mappedWinner:
      winner === "tie" ? "tie" : winner === "plan-a" ? planAProviderId : planBProviderId,
  };
}

function readWinner(output: string | undefined): "plan-a" | "plan-b" | "tie" {
  if (!output) return "plan-a";
  try {
    const winner = (JSON.parse(output) as { winner?: unknown }).winner;
    return winner === "plan-b" || winner === "tie" ? winner : "plan-a";
  } catch {
    return "plan-a";
  }
}

function absoluteResult(): Record<string, unknown> {
  return {
    requirementAssessments: [requirementOne(), requirementTwo()],
    criterionAssessments: [criterion()],
    contradictions: [],
    unsupportedRecommendations: [],
    summary: "Bounded judgment.",
  };
}

function requirementOne(): Record<string, unknown> {
  return {
    requirementId: "requirement-1",
    status: "complete",
    evidenceQuotes: ["First exact evidence."],
    gaps: [],
    rationale: "Present.",
  };
}

function requirementTwo(): Record<string, unknown> {
  return {
    requirementId: "requirement-2",
    status: "missing",
    evidenceQuotes: [],
    gaps: ["Missing."],
    rationale: "Absent.",
  };
}

function criterion(): Record<string, unknown> {
  return {
    criterion: "implementation-completeness",
    score: 4,
    evidenceQuotes: ["First exact evidence."],
    gaps: [],
    rationale: "Complete.",
  };
}

function pairwiseResult(
  overrides: { winner?: "plan-a" | "plan-b" | "tie"; confidence?: number } = {},
): Record<string, unknown> {
  return {
    winner: overrides.winner ?? "plan-a",
    confidence: overrides.confidence ?? 0.8,
    decidingFactors: ["Evidence"],
    planAStrengths: ["Specific"],
    planAGaps: [],
    planBStrengths: [],
    planBGaps: ["Vague"],
    rationale: "Bounded comparison.",
  };
}

function fakeProvider(id: string): ApiProvider {
  return {
    id: () => id,
    callApi: async () => ({ output: "{}" }),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
