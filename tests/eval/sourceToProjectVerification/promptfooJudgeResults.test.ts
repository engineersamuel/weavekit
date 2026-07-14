import type { EvaluateSummaryV3 } from "promptfoo";
import { describe, expect, it } from "vitest";
import { aggregatePlanQuality } from "../../../src/eval/sourceToProjectVerification/aggregation.js";
import type { ProjectVerificationCase } from "../../../src/eval/sourceToProjectVerification/case.js";
import { shouldSwapPairwiseOrder } from "../../../src/eval/sourceToProjectVerification/judge.js";
import type { PromptfooJudgeTask } from "../../../src/eval/sourceToProjectVerification/promptfooJudgeProvider.js";
import { projectPromptfooJudgeResults } from "../../../src/eval/sourceToProjectVerification/promptfooJudgeResults.js";

const JUDGES = ["gpt", "claude"];
const CASE_JSON = JSON.stringify({
  id: "case-1",
  requirements: [{ id: "practice-one/action-1" }],
  criteria: [{ criterion: "implementation-completeness" }],
});
const ABSOLUTE_TASK = {
  kind: "absolute",
  caseJson: CASE_JSON,
  providerId: "codex",
  planMarkdown: "First exact evidence.",
} satisfies PromptfooJudgeTask;
const PAIRWISE_TASK = {
  kind: "pairwise",
  caseId: "case-1",
  trialId: "trial-1",
  caseJson: CASE_JSON,
  providerIds: ["codex", "weavekit"],
  plans: { codex: "Codex plan", weavekit: "Weavekit plan" },
} satisfies PromptfooJudgeTask;

describe("projectPromptfooJudgeResults", () => {
  it("projects agreeing absolute rows, including repair and Promptfoo accounting metadata", () => {
    const repaired = {
      repairAttempted: true,
      retryCount: 1,
      evidenceDefectCount: 2,
      evidenceDefectCodes: ["missing-evidence"],
      evidenceDefectOmittedCount: 1,
    };
    const summary = promptfooSummary([
      row(ABSOLUTE_TASK, "gpt", absoluteResult(), { latencyMs: 101, cost: 0.12 }),
      row(ABSOLUTE_TASK, "claude", absoluteResult(), {
        latencyMs: 202,
        cost: 0.34,
        responseMetadata: { repairMetadata: repaired },
      }),
    ]);

    const result = projectPromptfooJudgeResults({
      summary,
      tasks: [ABSOLUTE_TASK],
      judgeIds: JUDGES,
    });

    expect(result.absolute).toHaveLength(2);
    expect(result.absolute[0]).toMatchObject({
      judgeId: "gpt",
      bamlClientName: "gpt-client",
      providerId: "codex",
      requirementIds: ["practice-one/action-1"],
      elapsedMs: 101,
      cost: 0.12,
      tokenUsage: TOKEN_USAGE,
      repairAttempted: false,
      result: absoluteResult(),
    });
    expect(result.absolute[1]).toMatchObject({
      judgeId: "claude",
      elapsedMs: 202,
      cost: 0.34,
      ...repaired,
      result: absoluteResult(),
    });
  });

  it("keeps Promptfoo execution and assertion failures invalid without manufacturing a score", () => {
    const failed = row(ABSOLUTE_TASK, "gpt", absoluteResult(), {
      success: false,
      error: "request failed token=super-secret-token",
      reason: "assertion failed key=super-secret-key",
      responseError: "provider error password=hunter2",
      latencyMs: 303,
      cost: 0.56,
      responseMetadata: {
        repairMetadata: {
          repairAttempted: true,
          retryCount: 1,
          evidenceDefectCount: 1,
          evidenceDefectCodes: ["missing-evidence"],
          evidenceDefectOmittedCount: 0,
        },
      },
    });
    const malformed = row(ABSOLUTE_TASK, "claude", "{not-json", { rawOutput: true });

    const result = projectPromptfooJudgeResults({
      summary: promptfooSummary([failed, malformed]),
      tasks: [ABSOLUTE_TASK],
      judgeIds: JUDGES,
    });

    expect(result.absolute[0]).toMatchObject({
      elapsedMs: 303,
      cost: 0.56,
      tokenUsage: TOKEN_USAGE,
      repairAttempted: true,
      retryCount: 1,
      reason: expect.stringContaining("[REDACTED]"),
      error: expect.stringContaining("[REDACTED]"),
    });
    expect(result.absolute[0]!.result).toBeUndefined();
    expect(result.absolute[1]!.result).toBeUndefined();
    expect(result.absolute[1]!.error).toMatch(/valid JSON/i);
  });

  it("uses a failed assertion reason as the invalid record error when execution itself succeeded", () => {
    const rows = [
      row(ABSOLUTE_TASK, "gpt", absoluteResult(), {
        success: false,
        reason: "assertion rejected secret=do-not-persist",
      }),
      row(ABSOLUTE_TASK, "claude", absoluteResult()),
    ];

    const result = projectPromptfooJudgeResults({
      summary: promptfooSummary(rows),
      tasks: [ABSOLUTE_TASK],
      judgeIds: JUDGES,
    });

    expect(result.absolute[0]!.result).toBeUndefined();
    expect(result.absolute[0]!.error).toMatch(/assertion rejected.*\[REDACTED\]/i);
    expect(result.absolute[0]!.reason).toMatch(/assertion rejected.*\[REDACTED\]/i);
  });

  it("leaves existing aggregation scores byte-for-byte unchanged after projection", () => {
    const panel = projectPromptfooJudgeResults({
      summary: promptfooSummary([
        row(ABSOLUTE_TASK, "gpt", absoluteResult()),
        row(ABSOLUTE_TASK, "claude", absoluteResult()),
      ]),
      tasks: [ABSOLUTE_TASK],
      judgeIds: JUDGES,
    });
    const quality = aggregatePlanQuality({
      definition: AGGREGATION_CASE,
      providerId: "codex",
      planMarkdown: ABSOLUTE_TASK.planMarkdown,
      judgeIds: JUDGES,
      records: panel.absolute,
    });

    expect(
      JSON.stringify({
        valid: quality.valid,
        score: quality.score,
        criteria: quality.criteria,
        practiceScores: quality.practiceScores,
        requirementScores: quality.requirementScores,
      }),
    ).toBe(
      '{"valid":true,"score":1,"criteria":{"source-practice-coverage":1,"implementation-completeness":1},"practiceScores":{"practice-one":1},"requirementScores":{"practice-one/action-1":1}}',
    );
  });

  it.each([
    ["agreed", ["codex", "codex"], "agreed", "codex"],
    ["tie", ["tie", "tie"], "agreed", "tie"],
    ["disputed", ["codex", "weavekit"], "disputed", undefined],
    ["single-judge", ["codex", "failed"], "single-judge", "codex"],
    ["invalid", ["failed", "failed"], "invalid", undefined],
  ] as const)(
    "resolves a %s pairwise panel through the canonical resolver",
    (_name, winners, status, winner) => {
      const rows = JUDGES.map((judgeId, index) =>
        winners[index] === "failed"
          ? row(PAIRWISE_TASK, judgeId, pairwiseResult("plan-a"), {
              success: false,
              reason: "failed assertion",
            })
          : (() => {
              const winner = anonymousWinnerForMapped(PAIRWISE_TASK, judgeId, winners[index]);
              return row(PAIRWISE_TASK, judgeId, pairwiseResult(winner), {
                pairwiseWinner: winner,
              });
            })(),
      );

      const result = projectPromptfooJudgeResults({
        summary: promptfooSummary(rows),
        tasks: [PAIRWISE_TASK],
        judgeIds: JUDGES,
      });

      expect(result.pairwise).toHaveLength(1);
      expect(result.pairwise[0]).toMatchObject({ status, ...(winner ? { winner } : {}) });
    },
  );

  it("defends against response metadata that disagrees with deterministic pairwise mapping", () => {
    const rows = JUDGES.map((judgeId) =>
      row(PAIRWISE_TASK, judgeId, pairwiseResult("plan-a"), {
        pairwiseWinner: "plan-a",
        responseMetadata: { mappedWinner: "tampered-provider" },
      }),
    );

    const result = projectPromptfooJudgeResults({
      summary: promptfooSummary(rows),
      tasks: [PAIRWISE_TASK],
      judgeIds: JUDGES,
    });

    expect(result.pairwise[0]).toMatchObject({ status: "invalid" });
    expect(result.pairwise[0]!.judgments[0]!.result).toBeUndefined();
    expect(result.pairwise[0]!.judgments[0]!.error).toMatch(/mapped winner/i);
  });

  it.each([
    ["missing", [row(ABSOLUTE_TASK, "gpt", absoluteResult())], /missing.*claude/i],
    [
      "duplicate",
      [
        row(ABSOLUTE_TASK, "gpt", absoluteResult()),
        row(ABSOLUTE_TASK, "gpt", absoluteResult()),
        row(ABSOLUTE_TASK, "claude", absoluteResult()),
      ],
      /duplicate/i,
    ],
    [
      "unknown provider",
      [
        row(ABSOLUTE_TASK, "gpt", absoluteResult()),
        row(ABSOLUTE_TASK, "claude", absoluteResult()),
        row(ABSOLUTE_TASK, "other", absoluteResult()),
      ],
      /unknown/i,
    ],
  ])("rejects a %s task/judge cross-product", (_name, rows, error) => {
    expect(() =>
      projectPromptfooJudgeResults({
        summary: promptfooSummary(rows),
        tasks: [ABSOLUTE_TASK],
        judgeIds: JUDGES,
      }),
    ).toThrow(error);
  });

  it("rejects task metadata that does not identify the exact expected task", () => {
    const rows = [
      row(ABSOLUTE_TASK, "gpt", absoluteResult(), {
        testMetadata: { taskProviderIds: ["weavekit"] },
      }),
      row(ABSOLUTE_TASK, "claude", absoluteResult()),
    ];

    expect(() =>
      projectPromptfooJudgeResults({
        summary: promptfooSummary(rows),
        tasks: [ABSOLUTE_TASK],
        judgeIds: JUDGES,
      }),
    ).toThrow(/metadata/i);
  });

  it("rejects absolute-row trial metadata that disagrees with the pairwise task identity", () => {
    const rows = [
      row(ABSOLUTE_TASK, "gpt", absoluteResult(), {
        testMetadata: { trialId: "tampered-trial" },
      }),
      row(ABSOLUTE_TASK, "claude", absoluteResult()),
      row(PAIRWISE_TASK, "gpt", pairwiseResult("plan-a"), { pairwiseWinner: "plan-a" }),
      row(PAIRWISE_TASK, "claude", pairwiseResult("plan-a"), { pairwiseWinner: "plan-a" }),
    ];

    expect(() =>
      projectPromptfooJudgeResults({
        summary: promptfooSummary(rows),
        tasks: [ABSOLUTE_TASK, PAIRWISE_TASK],
        judgeIds: JUDGES,
      }),
    ).toThrow(/metadata/i);
  });

  it.each([
    [
      "missing pairwise provider IDs",
      {
        kind: "pairwise",
        caseId: "case-1",
        trialId: "trial-1",
        caseJson: CASE_JSON,
        plans: {},
      },
    ],
    [
      "non-array pairwise provider IDs",
      {
        kind: "pairwise",
        caseId: "case-1",
        trialId: "trial-1",
        caseJson: CASE_JSON,
        providerIds: "codex:weavekit",
        plans: {},
      },
    ],
    [
      "malformed absolute fields",
      { kind: "absolute", caseJson: 42, providerId: "", planMarkdown: [] },
    ],
    ["unknown task kind", { kind: "mystery" }],
  ])("rejects %s with a bounded shared-schema error", (_name, malformedTask) => {
    let caught: unknown;
    try {
      projectPromptfooJudgeResults({
        summary: promptfooSummary([]),
        tasks: [malformedTask as never],
        judgeIds: JUDGES,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Invalid Promptfoo judge task/i);
    expect((caught as Error).message).not.toMatch(/\.join|not iterable|cannot read/i);
    expect((caught as Error).message.length).toBeLessThanOrEqual(1_024);
  });
});

const TOKEN_USAGE = {
  prompt: 10,
  completion: 5,
  cached: 0,
  total: 15,
  numRequests: 1,
  completionDetails: {},
  assertions: {},
};

const AGGREGATION_CASE: ProjectVerificationCase = {
  id: "case-1",
  title: "Case",
  objective: "Improve it",
  projectDir: "/tmp/project",
  sourcePath: "/tmp/source",
  expectedPractices: [
    {
      id: "practice-one",
      title: "Practice one",
      sourceExpectation: "First",
      projectEvidence: ["a"],
      expectedPlanActions: ["Do the thing"],
    },
  ],
  antiGoals: [],
  rubric: [
    { criterion: "source-practice-coverage", weight: 0.5, levels: "coverage" },
    { criterion: "implementation-completeness", weight: 0.5, levels: "complete" },
  ],
};

function promptfooSummary(results: unknown[]): EvaluateSummaryV3 {
  return {
    version: 3,
    timestamp: "2026-07-12T12:00:00.000Z",
    results,
    prompts: [],
    stats: {
      successes: results.length,
      failures: 0,
      errors: 0,
      tokenUsage: TOKEN_USAGE,
    },
  } as EvaluateSummaryV3;
}

function row(
  task: PromptfooJudgeTask,
  judgeId: string,
  output: unknown,
  overrides: {
    success?: boolean;
    error?: string;
    reason?: string;
    responseError?: string;
    latencyMs?: number;
    cost?: number;
    rawOutput?: boolean;
    pairwiseWinner?: "plan-a" | "plan-b" | "tie";
    responseMetadata?: Record<string, unknown>;
    testMetadata?: Record<string, unknown>;
  } = {},
) {
  const providerId = `source-to-project-judge:${judgeId}`;
  const responseMetadata = {
    kind: task.kind,
    judgeId,
    bamlClientName: `${judgeId}-client`,
    ...(task.kind === "absolute"
      ? { providerId: task.providerId }
      : pairwiseMetadata(task, judgeId, overrides.pairwiseWinner ?? "plan-a")),
    ...overrides.responseMetadata,
  };
  return {
    success: overrides.success ?? true,
    error: overrides.error,
    failureReason: overrides.success === false ? 2 : 0,
    score: overrides.success === false ? 0 : 1,
    latencyMs: overrides.latencyMs ?? 12,
    cost: overrides.cost ?? 0.01,
    tokenUsage: TOKEN_USAGE,
    namedScores: {},
    promptIdx: 0,
    testIdx: 0,
    promptId: "prompt-1",
    provider: { id: providerId },
    prompt: { raw: JSON.stringify(task), label: "judge task" },
    vars: { task: JSON.stringify(task) },
    response: {
      output: overrides.rawOutput ? output : JSON.stringify(output),
      ...(overrides.responseError ? { error: overrides.responseError } : {}),
      metadata: responseMetadata,
    },
    gradingResult: {
      pass: overrides.success ?? true,
      score: overrides.success === false ? 0 : 1,
      reason: overrides.reason ?? "Promptfoo judge output is valid.",
    },
    metadata: responseMetadata,
    testCase: {
      description: describeTask(task),
      vars: { task: JSON.stringify(task) },
      metadata: {
        taskKind: task.kind,
        taskProviderIds: task.kind === "absolute" ? [task.providerId] : task.providerIds,
        judgeProviderIds: JUDGES.map((id) => `source-to-project-judge:${id}`),
        artifactHashes: Object.fromEntries(
          (task.kind === "absolute" ? [task.providerId] : task.providerIds).map((id) => [
            id,
            "hash",
          ]),
        ),
        caseId: "case-1",
        trialId: "trial-1",
        ...overrides.testMetadata,
      },
    },
  };
}

function describeTask(task: PromptfooJudgeTask): string {
  return task.kind === "absolute"
    ? `absolute:${task.providerId}`
    : `pairwise:${task.trialId}:${task.providerIds.join(":")}`;
}

function pairwiseMetadata(
  task: Extract<PromptfooJudgeTask, { kind: "pairwise" }>,
  judgeId: string,
  winner: "plan-a" | "plan-b" | "tie",
) {
  const swap = shouldSwapPairwiseOrder({
    caseId: task.caseId,
    trialId: task.trialId,
    leftProviderId: task.providerIds[0],
    rightProviderId: task.providerIds[1],
    judgeId,
    judgeIds: JUDGES,
  });
  const [planAProviderId, planBProviderId] = swap
    ? [task.providerIds[1], task.providerIds[0]]
    : [task.providerIds[0], task.providerIds[1]];
  return {
    providerIds: task.providerIds,
    planAProviderId,
    planBProviderId,
    anonymousOrder: { planAProviderId, planBProviderId },
    anonymousWinner: winner,
    mappedWinner:
      winner === "tie" ? "tie" : winner === "plan-a" ? planAProviderId : planBProviderId,
  };
}

function anonymousWinnerForMapped(
  task: Extract<PromptfooJudgeTask, { kind: "pairwise" }>,
  judgeId: string,
  mappedWinner: "codex" | "weavekit" | "tie",
): "plan-a" | "plan-b" | "tie" {
  if (mappedWinner === "tie") return "tie";
  const planAWinner = pairwiseMetadata(task, judgeId, "plan-a").mappedWinner;
  return planAWinner === mappedWinner ? "plan-a" : "plan-b";
}

function absoluteResult() {
  return {
    requirementAssessments: [
      {
        requirementId: "practice-one/action-1",
        status: "complete" as const,
        evidenceQuotes: ["First exact evidence."],
        gaps: [],
        rationale: "Present.",
      },
    ],
    criterionAssessments: [
      {
        criterion: "implementation-completeness",
        score: 4,
        evidenceQuotes: ["First exact evidence."],
        gaps: [],
        rationale: "Complete.",
      },
    ],
    contradictions: [],
    unsupportedRecommendations: [],
    summary: "Bounded judgment.",
  };
}

function pairwiseResult(winner: "plan-a" | "plan-b" | "tie") {
  return {
    winner,
    confidence: 0.8,
    decidingFactors: ["Evidence"],
    planAStrengths: [],
    planAGaps: [],
    planBStrengths: [],
    planBGaps: [],
    rationale: "Bounded comparison.",
  };
}
