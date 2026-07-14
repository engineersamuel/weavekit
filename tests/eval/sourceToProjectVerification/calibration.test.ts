import { createHash } from "node:crypto";
import type { EvaluateSummaryV3 } from "promptfoo";
import { describe, expect, it } from "vitest";
import {
  shouldSwapPairwiseOrder,
  type SourceToProjectPlanJudge,
} from "../../../src/eval/sourceToProjectVerification/judge.js";
import type { PromptfooJudgeTask } from "../../../src/eval/sourceToProjectVerification/promptfooJudgeProvider.js";
import {
  formatSourceToProjectCalibrationCliOutput,
  runSourceToProjectJudgeCalibration,
} from "../../../src/eval/sourceToProjectVerification/calibration.js";

describe("source-to-project live judge calibration", () => {
  it("formats the calibration evaluation ID for CLI inspection", () => {
    expect(formatSourceToProjectCalibrationCliOutput("eval-calibration-1")).toBe(
      "Calibration evaluation ID: eval-calibration-1\n" +
        "View persisted evaluations: nubx promptfoo view\n",
    );
  });

  it("persists one production Promptfoo judge suite and derives ordering from its V3 projection", async () => {
    let directJudgeCalls = 0;
    const judges = [
      nonInvokedJudge("gpt", () => directJudgeCalls++),
      nonInvokedJudge("claude", () => directJudgeCalls++),
    ];
    const runnerCalls: Record<string, unknown>[] = [];
    let persistedSummary: EvaluateSummaryV3 | undefined;

    const result = await runSourceToProjectJudgeCalibration({
      judges,
      now: () => new Date("2026-07-12T16:00:00.000Z"),
      runPromptfoo: (async (args: Record<string, unknown>) => {
        runnerCalls.push(args);
        const tasks = promptfooJudgeTasks(args.suite);
        expect(tasks).toHaveLength(9);
        expect(tasks.filter((task) => task.kind === "absolute")).toHaveLength(3);
        expect(tasks.filter((task) => task.kind === "pairwise")).toHaveLength(6);
        expect((args.suite as { providers: unknown[] }).providers).toHaveLength(2);
        assertRealFixtureHashes(args.suite, tasks);
        persistedSummary = calibrationSummary(
          args.suite,
          tasks,
          judges.map(({ id }) => id),
        );
        return {
          evaluationId: "eval-calibration-1",
          summary: persistedSummary,
        };
      }) as never,
    });

    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]).toMatchObject({
      tags: {
        workflow: "source-to-project",
        phase: "calibration",
        runId: "2026-07-12T16:00:00.000Z",
        caseId: "todo-safe-write-path",
      },
      cache: false,
      maxConcurrency: 1,
    });
    expect(directJudgeCalls).toBe(0);
    expect(result.promptfooEvaluationId).toBe("eval-calibration-1");
    expect(result.promptfooViewCommand).toBe("nubx promptfoo view");
    expect(result.errors).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.scores.strong).toBeGreaterThan(result.scores.medium);
    expect(result.scores.medium).toBeGreaterThan(result.scores.weak);
    expect(result.pairwise.every((pair) => pair.status === "agreed")).toBe(true);
    expect(result.reversalChecks).toHaveLength(6);
    expect(result.reversalChecks.every((check) => check.passed)).toBe(true);
    assertSameJudgeOppositeOrders(
      persistedSummary!,
      judges.map(({ id }) => id),
    );
  });

  it("fails a same-judge reversal even when the other judge has the matching opposite order", async () => {
    const judges = [nonInvokedJudge("gpt"), nonInvokedJudge("claude")];
    const result = await runSourceToProjectJudgeCalibration({
      judges,
      now: () => new Date("2026-07-12T16:30:00.000Z"),
      runPromptfoo: (async (args: Record<string, unknown>) => {
        const tasks = promptfooJudgeTasks(args.suite);
        return {
          evaluationId: "eval-calibration-same-judge-reversal",
          summary: calibrationSummary(
            args.suite,
            tasks,
            judges.map(({ id }) => id),
            { reversalMismatchJudgeId: "gpt" },
          ),
        };
      }) as never,
    });

    expect(result.reversalChecks).toHaveLength(6);
    expect(result.reversalChecks.filter(({ judgeId }) => judgeId === "gpt")).toContainEqual(
      expect.objectContaining({ passed: false }),
    );
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/gpt.*changed mapped winner.*A\/B reversal/i)]),
    );
  });

  it("reports projected invalid evidence without invoking a calibration-specific judge path", async () => {
    const judges = [nonInvokedJudge("gpt"), nonInvokedJudge("claude")];
    const result = await runSourceToProjectJudgeCalibration({
      judges,
      now: () => new Date("2026-07-12T17:00:00.000Z"),
      runPromptfoo: (async (args: Record<string, unknown>) => {
        const tasks = promptfooJudgeTasks(args.suite);
        return {
          evaluationId: "eval-calibration-invalid",
          summary: calibrationSummary(
            args.suite,
            tasks,
            judges.map(({ id }) => id),
            { invalidEvidence: { judgeId: "claude", providerId: "medium" } },
          ),
        };
      }) as never,
    });

    expect(result.passed).toBe(false);
    expect(result.promptfooEvaluationId).toBe("eval-calibration-invalid");
    expect(result.absolute).toHaveLength(6);
    expect(result.qualityErrors.medium).toEqual([
      expect.stringMatching(/claude.*project-specific-diagnosis.*evidence quote.*not in the plan/i),
    ]);
    expect(result.perJudgeQualityErrors.claude.medium).toEqual(result.qualityErrors.medium);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /Calibration quality for claude\/medium is invalid:.*project-specific-diagnosis.*evidence quote.*not in the plan/i,
        ),
      ]),
    );
    expect(result.errors).not.toContain("claude did not rank strong > medium > weak.");
  });
});

function nonInvokedJudge(
  id: string,
  onCall: () => void = () => undefined,
): SourceToProjectPlanJudge {
  const fail = async (): Promise<never> => {
    onCall();
    throw new Error("calibration judge methods must run only inside Promptfoo providers");
  };
  return {
    id,
    bamlClientName: `${id}-client`,
    judgePlan: fail,
    judgePlanWithMetadata: fail,
    comparePlans: fail,
  };
}

function promptfooJudgeTasks(suite: unknown): PromptfooJudgeTask[] {
  const value = suite as { tests?: Array<{ vars?: Record<string, unknown> }> };
  return (value.tests ?? []).map((test) =>
    JSON.parse(String(test.vars?.task)),
  ) as PromptfooJudgeTask[];
}

function assertRealFixtureHashes(suite: unknown, tasks: PromptfooJudgeTask[]): void {
  const tests = (
    suite as { tests: Array<{ metadata?: { artifactHashes?: Record<string, string> } }> }
  ).tests;
  for (const [index, task] of tasks.entries()) {
    const hashes = tests[index]?.metadata?.artifactHashes;
    const plans = task.kind === "absolute" ? { [task.providerId]: task.planMarkdown } : task.plans;
    for (const [providerId, markdown] of Object.entries(plans)) {
      expect(hashes?.[providerId]).toBe(createHash("sha256").update(markdown).digest("hex"));
    }
  }
}

function calibrationSummary(
  suite: unknown,
  tasks: PromptfooJudgeTask[],
  judgeIds: string[],
  options: {
    invalidEvidence?: { judgeId: string; providerId: string };
    reversalMismatchJudgeId?: string;
  } = {},
): EvaluateSummaryV3 {
  const tests = (suite as { tests?: Array<Record<string, unknown>> }).tests ?? [];
  const pairwiseTrialIds = tasks.flatMap((task) =>
    task.kind === "pairwise" ? [task.trialId] : [],
  );
  const baseTrialId = pairwiseTrialIds[0];
  const firstPair = tasks.find((task) => task.kind === "pairwise")?.providerIds;
  const results = tasks.flatMap((task, taskIndex) =>
    judgeIds.map((judgeId) => {
      const output = (() => {
        if (task.kind === "absolute") {
          return absoluteResult(task, judgeId, options.invalidEvidence);
        }
        const pairwise = pairwiseResult(task, judgeId, judgeIds);
        if (
          judgeId !== options.reversalMismatchJudgeId ||
          task.trialId === baseTrialId ||
          !firstPair?.every((providerId) => task.providerIds.includes(providerId))
        ) {
          return pairwise;
        }
        return {
          ...pairwise,
          winner: pairwise.winner === "plan-a" ? "plan-b" : "plan-a",
        };
      })();
      const metadata = responseMetadata(task, judgeId, judgeIds, output);
      return {
        success: true,
        failureReason: 0,
        score: 1,
        latencyMs: 1,
        cost: 0,
        tokenUsage: TOKEN_USAGE,
        namedScores: {},
        promptIdx: 0,
        testIdx: taskIndex,
        promptId: "calibration",
        provider: { id: `source-to-project-judge:${judgeId}` },
        prompt: { raw: JSON.stringify(task), label: "calibration" },
        vars: { task: JSON.stringify(task) },
        response: { output: JSON.stringify(output), metadata },
        gradingResult: { pass: true, score: 1, reason: "valid" },
        metadata,
        testCase: tests[taskIndex],
      };
    }),
  );
  return {
    version: 3,
    timestamp: "2026-07-12T16:00:00.000Z",
    results,
    prompts: [],
    stats: { successes: results.length, failures: 0, errors: 0, tokenUsage: TOKEN_USAGE },
  } as EvaluateSummaryV3;
}

function assertSameJudgeOppositeOrders(summary: EvaluateSummaryV3, judgeIds: string[]): void {
  const pairwiseRows = summary.results.filter(
    (row) => (row.response?.metadata as { kind?: unknown } | undefined)?.kind === "pairwise",
  );
  for (const judgeId of judgeIds) {
    const judgeRows = pairwiseRows.filter(
      (row) => row.provider?.id === `source-to-project-judge:${judgeId}`,
    );
    const pairKeys = new Set(
      judgeRows.map((row) => {
        const metadata = row.response!.metadata as { providerIds: string[] };
        return [...metadata.providerIds].sort().join("\0");
      }),
    );
    expect(pairKeys).toHaveLength(3);
    for (const pairKey of pairKeys) {
      const rows = judgeRows.filter((row) => {
        const metadata = row.response!.metadata as { providerIds: string[] };
        return [...metadata.providerIds].sort().join("\0") === pairKey;
      });
      expect(rows).toHaveLength(2);
      const orders = rows.map((row) => {
        const metadata = row.response!.metadata as {
          planAProviderId: string;
          planBProviderId: string;
        };
        return [metadata.planAProviderId, metadata.planBProviderId] as const;
      });
      expect(orders[1]).toEqual([orders[0]![1], orders[0]![0]]);
    }
  }
}

const TOKEN_USAGE = {
  prompt: 1,
  completion: 1,
  cached: 0,
  total: 2,
  numRequests: 1,
  completionDetails: {},
  assertions: {},
};

function absoluteResult(
  task: Extract<PromptfooJudgeTask, { kind: "absolute" }>,
  judgeId: string,
  invalidEvidence: { judgeId: string; providerId: string } | undefined,
) {
  const rank = planRank(task.planMarkdown);
  const evidenceQuote = task.planMarkdown.split("\n", 1)[0]!;
  const contract = JSON.parse(task.caseJson) as {
    requirements: Array<{ id: string }>;
    criteria: Array<{ criterion: string }>;
  };
  return {
    requirementAssessments: contract.requirements.map(({ id: requirementId }, index) => ({
      requirementId,
      status: rank === 3 ? "complete" : rank === 2 && index < 5 ? "partial" : "missing",
      evidenceQuotes: rank === 1 ? [] : [evidenceQuote],
      gaps: rank === 3 ? [] : ["gap"],
      rationale: "calibration",
    })),
    criterionAssessments: contract.criteria.map(({ criterion }, index) => ({
      criterion,
      score: rank === 3 ? 4 : rank === 2 ? 2 : 1,
      evidenceQuotes: [
        invalidEvidence?.judgeId === judgeId &&
        invalidEvidence.providerId === task.providerId &&
        index === 0
          ? "fabricated evidence"
          : evidenceQuote,
      ],
      gaps: rank === 3 ? [] : ["gap"],
      rationale: "calibration",
    })),
    contradictions: [],
    unsupportedRecommendations: [],
    summary: "calibration",
  };
}

function pairwiseResult(
  task: Extract<PromptfooJudgeTask, { kind: "pairwise" }>,
  judgeId: string,
  judgeIds: string[],
) {
  const order = pairwiseOrder(task, judgeId, judgeIds);
  const winner =
    planRank(task.plans[order[0]]!) > planRank(task.plans[order[1]]!) ? "plan-a" : "plan-b";
  return {
    winner,
    confidence: 1,
    decidingFactors: ["coverage"],
    planAStrengths: [],
    planAGaps: [],
    planBStrengths: [],
    planBGaps: [],
    rationale: "higher calibration rank",
  };
}

function responseMetadata(
  task: PromptfooJudgeTask,
  judgeId: string,
  judgeIds: string[],
  output: Record<string, unknown>,
) {
  const base = { kind: task.kind, judgeId, bamlClientName: `${judgeId}-client` };
  if (task.kind === "absolute") {
    return {
      ...base,
      providerId: task.providerId,
      repairMetadata: {
        repairAttempted: false,
        retryCount: 0,
        evidenceDefectCount: 0,
        evidenceDefectCodes: [],
        evidenceDefectOmittedCount: 0,
      },
    };
  }
  const [planAProviderId, planBProviderId] = pairwiseOrder(task, judgeId, judgeIds);
  const anonymousWinner = output.winner;
  return {
    ...base,
    providerIds: task.providerIds,
    planAProviderId,
    planBProviderId,
    anonymousOrder: { planAProviderId, planBProviderId },
    anonymousWinner,
    mappedWinner:
      anonymousWinner === "plan-a"
        ? planAProviderId
        : anonymousWinner === "plan-b"
          ? planBProviderId
          : "tie",
  };
}

function pairwiseOrder(
  task: Extract<PromptfooJudgeTask, { kind: "pairwise" }>,
  judgeId: string,
  judgeIds: string[],
): [string, string] {
  const swap = shouldSwapPairwiseOrder({
    caseId: task.caseId,
    trialId: task.trialId,
    leftProviderId: task.providerIds[0],
    rightProviderId: task.providerIds[1],
    judgeId,
    judgeIds,
  });
  return swap ? [task.providerIds[1], task.providerIds[0]] : [...task.providerIds];
}

function planRank(markdown: string): number {
  if (markdown.includes("# Strong")) return 3;
  if (markdown.includes("# Medium")) return 2;
  return 1;
}
